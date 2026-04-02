// xAI Voice Agent API → リアル日本語音声生成サーバー
import { createServer } from 'http';
import { WebSocket } from 'ws';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const XAI_API_KEY = process.env.XAI_API_KEY || '';
const CACHE_DIR = path.join(__dirname, 'audio-cache');
if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

// PCM16 → WAV変換
function pcmToWav(pcmBuffer, sampleRate = 24000, channels = 1, bitDepth = 16) {
  const byteRate = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const dataSize = pcmBuffer.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitDepth, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(buffer, 44);
  return buffer;
}

async function generateVoice(text) {
  const cacheKey = createHash('md5').update(text).digest('hex');
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.wav`);
  if (existsSync(cachePath)) {
    console.log('[cache hit]', text.slice(0, 30));
    return readFileSync(cachePath);
  }

  console.log('[generate]', text.slice(0, 40));
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.x.ai/v1/realtime', {
      headers: { Authorization: `Bearer ${XAI_API_KEY}` }
    });
    const chunks = [];
    let timeout;

    ws.on('open', () => {
      ws.send(JSON.stringify({
        type: 'session.update',
        session: {
          voice: 'Archer',
          instructions: 'You are an extremely energetic and excited Japanese announcer. Shout in Japanese with maximum enthusiasm and energy, like a sports commentator announcing a big goal. Very loud, very excited, very short.',
          turn_detection: null,
          modalities: ['text', 'audio'],
          output_audio_format: 'pcm16'
        }
      }));
      ws.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message', role: 'user',
          content: [{ type: 'input_text', text }]
        }
      }));
      ws.send(JSON.stringify({ type: 'response.create' }));
      timeout = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 30000);
    });

    ws.on('message', (data) => {
      const event = JSON.parse(data);
      if (event.type === 'response.output_audio.delta') {
        chunks.push(Buffer.from(event.delta, 'base64'));
      } else if (event.type === 'response.done') {
        clearTimeout(timeout);
        ws.close();
        if (chunks.length > 0) {
          const wav = pcmToWav(Buffer.concat(chunks));
          writeFileSync(cachePath, wav);
          resolve(wav);
        } else reject(new Error('no audio'));
      } else if (event.type === 'error') {
        clearTimeout(timeout);
        ws.close();
        reject(new Error(JSON.stringify(event)));
      }
    });
    ws.on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

const server = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  if (req.method === 'POST' && req.url === '/speak') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        const wav = await generateVoice(text);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length });
        res.end(wav);
      } catch(e) {
        console.error(e);
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }
  res.writeHead(404); res.end();
});

server.listen(8920, () => console.log('🎙️ Voice server: http://localhost:8920'));
