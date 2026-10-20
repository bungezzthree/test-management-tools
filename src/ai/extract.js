import path from 'node:path';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { HttpError } from '../db.js';

export const DOCUMENT_TYPES = '.pdf, .docx, .txt, .md, .csv, .xlsx, .json, .feature';

/**
 * Turns an uploaded requirement document (BRD, FSD, TSD, user stories...) into text.
 * Returns { name, mime, buffer, text, pages? }.
 */
export async function extractDocument(file) {
  const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const ext = path.extname(name).toLowerCase();
  const buffer = file.buffer;
  try {
    if (ext === '.pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buffer));
      const { text, totalPages } = await extractText(pdf, { mergePages: true });
      return { name, mime: 'application/pdf', buffer, text: tidy(text), pages: totalPages };
    }
    if (ext === '.docx') {
      const { value } = await mammoth.extractRawText({ buffer });
      return { name, mime: 'text/plain', text: tidy(value) };
    }
    if (ext === '.xlsx') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buffer);
      const parts = [];
      wb.eachSheet((ws) => {
        const rows = [];
        ws.eachRow((row) => {
          const cells = [];
          row.eachCell({ includeEmpty: true }, (c) => cells.push(String(c.text ?? '').replace(/\s+/g, ' ').trim()));
          if (cells.some(Boolean)) rows.push(cells.join(' | '));
        });
        if (rows.length) parts.push(`## Sheet: ${ws.name}\n${rows.join('\n')}`);
      });
      return { name, mime: 'text/plain', text: parts.join('\n\n') };
    }
    if (['.txt', '.md', '.csv', '.json', '.feature', '.text', '.markdown'].includes(ext)) {
      return { name, mime: 'text/plain', text: tidy(buffer.toString('utf8').replace(/^﻿/, '')) };
    }
  } catch (e) {
    throw new HttpError(400, `Could not read "${name}": ${e.message}`);
  }
  throw new HttpError(400, `"${name}" is not a supported document type. Use ${DOCUMENT_TYPES}. For .doc files, save as .docx first.`);
}

const tidy = (s) => String(s || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
