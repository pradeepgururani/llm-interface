const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Serve static files from 'public' directory

// Store for API keys (in production, use proper secure storage)
const apiKeys = new Map();

// Endpoint to save API keys
app.post('/api/keys', (req, res) => {
  const { provider, apiKey } = req.body;
  
  if (!provider || !apiKey) {
    return res.status(400).json({ error: 'Provider and API key are required' });
  }
  
  // Simple validation
  if (provider === 'openai' && !apiKey.startsWith('sk-')) {
    return res.status(400).json({ error: 'Invalid OpenAI API key format' });
  }
  
  if (provider === 'claude' && !apiKey.startsWith('sk-ant-')) {
    return res.status(400).json({ error: 'Invalid Anthropic API key format' });
  }
  
  apiKeys.set(provider, apiKey);
  res.json({ success: true, message: `${provider} API key saved` });
});

// Endpoint to validate API keys
app.post('/api/validate', async (req, res) => {
  const { provider, apiKey } = req.body;
  
  try {
    let isValid = false;
    
    if (provider === 'openai') {
      isValid = await validateOpenAIKey(apiKey);
    } else if (provider === 'claude') {
      isValid = await validateClaudeKey(apiKey);
    }
    
    res.json({ valid: isValid });
  } catch (error) {
    console.error(`Validation error for ${provider}:`, error.message);
    res.status(500).json({ error: 'Validation failed', details: error.message });
  }
});

// Main chat endpoint
app.post('/api/chat', async (req, res) => {
  const { provider, model, messages, stream = false } = req.body;
  
  const apiKey = apiKeys.get(provider);
  if (!apiKey) {
    return res.status(401).json({ error: `No API key found for ${provider}` });
  }
  
  try {
    if (provider === 'openai') {
      if (stream) {
        await streamOpenAIResponse(res, apiKey, model, messages);
      } else {
        const response = await chatOpenAI(apiKey, model, messages);
        res.json(response);
      }
    } else if (provider === 'claude') {
      if (stream) {
        await streamClaudeResponse(res, apiKey, model, messages);
      } else {
        const response = await chatClaude(apiKey, model, messages);
        res.json(response);
      }
    } else {
      res.status(400).json({ error: 'Unsupported provider' });
    }
  } catch (error) {
    console.error(`Chat error for ${provider}:`, error.message);
    res.status(500).json({ error: 'Chat request failed', details: error.message });
  }
});

// OpenAI functions
async function validateOpenAIKey(apiKey) {
  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      headers: {
        'Authorization': `Bearer ${apiKey}`
      }
    });
    return response.ok;
  } catch (error) {
    return false;
  }
}

async function chatOpenAI(apiKey, model, messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      max_tokens: 4000
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }
  
  const data = await response.json();
  return {
    content: data.choices[0].message.content,
    model: data.model,
    usage: data.usage
  };
}

async function streamOpenAIResponse(res, apiKey, model, messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: model,
      messages: messages,
      max_tokens: 4000,
      stream: true
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error (${response.status}): ${error}`);
  }
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  const reader = response.body;
  let buffer = '';
  
  reader.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            res.write(`data: ${JSON.stringify({ content: delta, finished: false })}\n\n`);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  });
  
  reader.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });
  
  reader.on('error', (error) => {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  });
}

// Claude functions
async function validateClaudeKey(apiKey) {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'test' }]
      })
    });
    
    // 400 might be rate limit but key is valid, 401 is invalid key
    return response.ok || response.status === 400;
  } catch (error) {
    return false;
  }
}

async function chatClaude(apiKey, model, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4000,
      messages: messages
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }
  
  const data = await response.json();
  return {
    content: data.content[0].text,
    model: data.model,
    usage: data.usage
  };
}

async function streamClaudeResponse(res, apiKey, model, messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: model,
      max_tokens: 4000,
      messages: messages,
      stream: true
    })
  });
  
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
  }
  
  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  
  const reader = response.body;
  let buffer = '';
  
  reader.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6);
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'content_block_delta') {
            const content = parsed.delta.text || '';
            res.write(`data: ${JSON.stringify({ content, finished: false })}\n\n`);
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }
  });
  
  reader.on('end', () => {
    res.write('data: [DONE]\n\n');
    res.end();
  });
  
  reader.on('error', (error) => {
    console.error('Stream error:', error);
    res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
    res.end();
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve the main HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 AI Assistant Proxy Server running on http://localhost:${PORT}`);
  console.log(`📁 Put your HTML file in the 'public' directory as 'index.html'`);
  console.log(`🔑 API keys are stored in memory (restart to clear)`);
});

module.exports = app;