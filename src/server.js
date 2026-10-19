import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import { api } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Internal error';
  if (err instanceof multer.MulterError) {
    status = 400;
    if (err.code === 'LIMIT_FILE_SIZE') message = 'File is too large';
  } else if (err instanceof SyntaxError && err.type === 'entity.parse.failed') {
    status = 400;
    message = 'Invalid JSON';
  }
  if (status >= 500) console.error(err);
  if (res.headersSent) return res.end();
  res.status(status).json({ error: status >= 500 ? 'Internal server error' : message });
});

app.listen(PORT, HOST, () => console.log(`Test Management Tools running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`));
