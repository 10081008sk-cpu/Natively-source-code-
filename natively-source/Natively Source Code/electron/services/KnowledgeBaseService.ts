
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';

export interface KnowledgeBaseFile {
  id: string;
  name: string;
  size: number;
  type: string;
  entriesCount: number;
  status: 'indexing' | 'ready' | 'error';
  lastIndexed: number;
  error?: string;
}

interface KnowledgeBaseChunk {
  text: string;
  source: string;
  fileId: string;
}

interface KnowledgeBaseIndex {
  enabled: boolean;
  confidenceThreshold: number;
  files: KnowledgeBaseFile[];
  chunks: KnowledgeBaseChunk[];
}

interface KnowledgeBaseMatch {
  text: string;
  source: string;
  confidence: number;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILE_CHARS = 500_000;
const MAX_FILES = 100;
const MAX_CHUNKS_PER_FILE = 500;
const MAX_TOTAL_CHUNKS = 5_000;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.json', '.csv', '.pdf']);

export class KnowledgeBaseService {
  private static instance: KnowledgeBaseService | null = null;

  private readonly directory: string;
  private readonly indexPath: string;

  private index: KnowledgeBaseIndex = {
    enabled: false,
    confidenceThreshold: 0.8,
    files: [],
    chunks: [],
  };

  private constructor() {
    this.directory = path.join(app.getPath('userData'), 'knowledge-base');
    this.indexPath = path.join(this.directory, 'index.json');
    this.loadIndex();
  }

  static getInstance(): KnowledgeBaseService {
    if (!KnowledgeBaseService.instance) {
      KnowledgeBaseService.instance = new KnowledgeBaseService();
    }
    return KnowledgeBaseService.instance;
  }

  getSettings(): {
    enabled: boolean;
    confidenceThreshold: number;
    files: KnowledgeBaseFile[];
  } {
    return {
      enabled: this.index.enabled,
      confidenceThreshold: this.index.confidenceThreshold,
      files: this.index.files.map(file => ({ ...file })),
    };
  }

  async updateSettings(settings: {
    enabled?: boolean;
    confidenceThreshold?: number;
  }): Promise<void> {
    if (typeof settings.enabled === 'boolean') {
      this.index.enabled = settings.enabled;
    }

    if (typeof settings.confidenceThreshold === 'number') {
      if (!Number.isFinite(settings.confidenceThreshold)) {
        throw new Error('Invalid confidence threshold.');
      }

      this.index.confidenceThreshold = Math.max(
        0.5,
        Math.min(0.95, settings.confidenceThreshold),
      );
    }

    await this.saveIndex();
  }

  async addDocument(input: {
    name: string;
    dataBase64: string;
  }): Promise<KnowledgeBaseFile> {
    if (!input || typeof input.name !== 'string' ||
        typeof input.dataBase64 !== 'string') {
      throw new Error('Invalid document upload.');
    }

    const name = path.basename(input.name.trim());

    if (!name || name === '.' || name === '..') {
      throw new Error('Invalid file name.');
    }

    const extension = path.extname(name).toLowerCase();

    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`Unsupported file type: ${extension || 'unknown'}`);
    }

    const bytes = Buffer.from(input.dataBase64, 'base64');

    if (!bytes.length || bytes.length > MAX_FILE_SIZE) {
      throw new Error('Choose a non-empty file up to 10 MB.');
    }

    if (this.index.files.length >= MAX_FILES) {
      throw new Error(`The Knowledge Base supports up to ${MAX_FILES} files.`);
    }

    const fileId = randomUUID();
    const extractedText = await this.extractText(bytes, extension);

    if (!extractedText.trim()) {
      throw new Error('No readable text was found in this document.');
    }

    if (extractedText.length > MAX_FILE_CHARS) {
      throw new Error(
        `Extracted text exceeds the ${MAX_FILE_CHARS.toLocaleString()} character limit.`,
      );
    }

    const chunks = this.splitIntoChunks(extractedText, name);

    if (!chunks.length) {
      throw new Error('No indexable text was found in this document.');
    }

    if (chunks.length > MAX_CHUNKS_PER_FILE) {
      throw new Error(
        `This document creates too many entries. Maximum: ${MAX_CHUNKS_PER_FILE}.`,
      );
    }

    if (this.index.chunks.length + chunks.length > MAX_TOTAL_CHUNKS) {
      throw new Error(
        `The Knowledge Base supports up to ${MAX_TOTAL_CHUNKS} total entries.`,
      );
    }

    const file: KnowledgeBaseFile = {
      id: fileId,
      name,
      size: bytes.length,
      type: extension.slice(1),
      entriesCount: chunks.length,
      status: 'ready',
      lastIndexed: Date.now(),
    };

    this.index.files.push(file);
    this.index.chunks.push(
      ...chunks.map(chunk => ({
        text: chunk,
        source: name,
        fileId,
      })),
    );

    try {
      await this.saveIndex();
    } catch (error) {
      this.index.files = this.index.files.filter(item => item.id !== fileId);
      this.index.chunks = this.index.chunks.filter(
        item => item.fileId !== fileId,
      );
      throw error;
    }

    return { ...file };
  }

  async removeDocument(id: string): Promise<void> {
    const exists = this.index.files.some(file => file.id === id);

    if (!exists) {
      throw new Error('Document not found.');
    }

    this.index.files = this.index.files.filter(file => file.id !== id);
    this.index.chunks = this.index.chunks.filter(
      chunk => chunk.fileId !== id,
    );

    await this.saveIndex();
  }

  async clear(): Promise<void> {
    this.index.files = [];
    this.index.chunks = [];
    await this.saveIndex();
  }

  search(query: string, limit = 5): KnowledgeBaseMatch[] {
    if (!this.index.enabled || typeof query !== 'string' || !query.trim()) {
      return [];
    }

    const queryTokens = this.tokenize(query);

    if (!queryTokens.length) {
      return [];
    }

    const threshold = this.index.confidenceThreshold;

    return this.index.chunks
      .map(chunk => {
        const chunkTokens = new Set(this.tokenize(chunk.text));
        const matched = queryTokens.filter(token => chunkTokens.has(token));
        const confidence = matched.length / queryTokens.length;

        return {
          text: chunk.text,
          source: chunk.source,
          confidence,
        };
      })
      .filter(match => match.confidence >= threshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, Math.max(1, Math.min(20, limit)));
  }

  private async extractText(
    bytes: Buffer,
    extension: string,
  ): Promise<string> {
    if (extension === '.pdf') {
      return this.extractPdfText(bytes);
    }

    const text = bytes.toString('utf8');

    if (extension === '.json') {
      try {
        // Validate JSON, but retain its readable original formatting.
        JSON.parse(text);
      } catch {
        throw new Error('The uploaded JSON file is invalid.');
      }
    }

    return text.replace(/\u0000/g, '');
  }

  private async extractPdfText(bytes: Buffer): Promise<string> {
    let pdfParse: any;

    try {
      pdfParse = require('pdf-parse');
    } catch {
      throw new Error(
        'PDF extraction is unavailable. Install the pdf-parse package and rebuild the app.',
      );
    }

    try {
      // Compatible with the commonly used pdf-parse 1.x API.
      if (typeof pdfParse === 'function') {
        const result = await pdfParse(bytes);
        return typeof result?.text === 'string' ? result.text : '';
      }

      throw new Error('Unsupported pdf-parse API version.');
    } catch (error: any) {
      throw new Error(
        `Could not extract text from PDF: ${error?.message || 'Invalid PDF'}`,
      );
    }
  }

  private splitIntoChunks(text: string, source: string): string[] {
    const normalized = text
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .trim();

    const paragraphs = normalized
      .split(/\n\s*\n/)
      .map(part => part.trim())
      .filter(Boolean);

    const chunks: string[] = [];
    let current = '';

    const maxChunkLength = 1_200;

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxChunkLength) {
        if (current) {
          chunks.push(current);
          current = '';
        }

        for (let offset = 0; offset < paragraph.length; offset += maxChunkLength) {
          chunks.push(paragraph.slice(offset, offset + maxChunkLength));
          if (chunks.length > MAX_CHUNKS_PER_FILE) {
            throw new Error(
              `This document creates too many entries. Maximum: ${MAX_CHUNKS_PER_FILE}.`,
            );
          }
        }

        continue;
      }

      if (current && current.length + paragraph.length + 2 > maxChunkLength) {
        chunks.push(current);
        current = paragraph;
      } else {
        current = current ? `${current}\n\n${paragraph}` : paragraph;
      }

      if (chunks.length > MAX_CHUNKS_PER_FILE) {
        throw new Error(
          `This document creates too many entries. Maximum: ${MAX_CHUNKS_PER_FILE}.`,
        );
      }
    }

    if (current) {
      chunks.push(current);
    }

    return chunks.slice(0, MAX_CHUNKS_PER_FILE);
  }

  private tokenize(value: string): string[] {
    return Array.from(
      new Set(
        value
          .toLowerCase()
          .replace(/[^a-z0-9+#.\s]/g, ' ')
          .split(/\s+/)
          .filter(token => token.length > 2)
          .map(token => {
            if (token.endsWith('ies') && token.length > 4) {
              return `${token.slice(0, -3)}y`;
            }
            if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) {
              return token.slice(0, -1);
            }
            return token;
          }),
      ),
    );
  }

  private loadIndex(): void {
    try {
      if (!fs.existsSync(this.indexPath)) {
        return;
      }

      const raw = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(raw);

      this.index = {
        enabled: parsed.enabled === true,
        confidenceThreshold:
          typeof parsed.confidenceThreshold === 'number'
            ? Math.max(0.5, Math.min(0.95, parsed.confidenceThreshold))
            : 0.8,
        files: Array.isArray(parsed.files) ? parsed.files : [],
        chunks: Array.isArray(parsed.chunks) ? parsed.chunks : [],
      };
    } catch (error) {
      console.error('[KnowledgeBase] Could not load local index:', error);
      this.index = {
        enabled: false,
        confidenceThreshold: 0.8,
        files: [],
        chunks: [],
      };
    }
  }

  private async saveIndex(): Promise<void> {
    await fs.promises.mkdir(this.directory, { recursive: true });

    const temporaryPath = `${this.indexPath}.tmp`;
    const data = JSON.stringify(this.index, null, 2);

    await fs.promises.writeFile(temporaryPath, data, 'utf8');
    await fs.promises.rename(temporaryPath, this.indexPath);
  }
}
