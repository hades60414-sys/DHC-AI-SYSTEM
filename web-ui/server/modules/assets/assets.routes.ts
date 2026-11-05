import express from 'express';
import multer from 'multer';

import {
  buildStoredAttachmentRecords,
  buildStoredImageRecords,
  ensureImageAssetsDir,
  isAllowedImageMimeType,
  openStoredAttachmentAsset,
} from '@/modules/assets/services/image-assets.service.js';
import {
  CHUNK_SIZE,
  ChunkedUploadError,
  cancelChunkedUpload,
  completeChunkedUpload,
  startChunkedUpload,
  writeUploadChunk,
} from '@/modules/assets/services/chunked-upload.service.js';

const router = express.Router();

// Multer writes uploads straight into the global assets folder; the service
// owns the folder location and the response record shape.
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureImageAssetsDir()
      .then((assetsDir) => cb(null, assetsDir))
      .catch((error) => cb(error as Error, ''));
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
    cb(null, `${uniqueSuffix}-${sanitizedName}`);
  },
});

const upload = multer({

  defParamCharset: 'utf8', // DHC CLI: browsers send UTF-8 filenames; multer defaults to latin1 (mojibake for Chinese)
  storage,
  fileFilter: (req, file, cb) => {
    if (isAllowedImageMimeType(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed.'));
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 5,
  },
});

const attachmentUpload = multer({

  defParamCharset: 'utf8', // DHC CLI: browsers send UTF-8 filenames; multer defaults to latin1 (mojibake for Chinese)
  storage,
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 10,
  },
});

/**
 * Stores chat image attachments in the global `~/.cloudcli/assets` folder and
 * returns their absolute paths for use in provider prompts and chat history.
 */
router.post('/images', (req, res) => {
  upload.array('images', 5)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No image files provided' });
    }

    res.json({ images: buildStoredImageRecords(files) });
  });
});

/**
 * Stores provider-neutral chat attachments. Files of any MIME type are
 * accepted because providers inspect them as data through their file-reading
 * tools; uploads are capped at 10 files and 10MB per file.
 */
router.post('/files', (req, res) => {
  attachmentUpload.array('files', 10)(req, res, (err: unknown) => {
    if (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      return res.status(400).json({ error: message });
    }

    const files = Array.isArray(req.files) ? req.files : [];
    if (files.length === 0) {
      return res.status(400).json({ error: 'No files provided' });
    }

    res.json({ attachments: buildStoredAttachmentRecords(files) });
  });
});

// DHC CLI: chunked upload for attachments over 10MB (see chunked-upload.service.ts).
const sendChunkedError = (res: express.Response, error: unknown) => {
  if (error instanceof ChunkedUploadError) {
    return res.status(error.status).json({ error: error.message });
  }
  console.error('Chunked upload failed:', error);
  return res.status(500).json({ error: error instanceof Error ? error.message : 'Upload failed' });
};

router.post('/uploads', async (req, res) => {
  try {
    res.json(await startChunkedUpload(req.body ?? {}));
  } catch (error) {
    sendChunkedError(res, error);
  }
});

router.put(
  '/uploads/:id/chunks/:index',
  express.raw({ type: () => true, limit: CHUNK_SIZE + 1024 }),
  async (req, res) => {
    try {
      const sha256 = req.get('x-chunk-sha256');
      res.json(await writeUploadChunk(req.params.id, Number(req.params.index), req.body, sha256));
    } catch (error) {
      sendChunkedError(res, error);
    }
  },
);

router.post('/uploads/:id/complete', async (req, res) => {
  try {
    res.json(await completeChunkedUpload(req.params.id));
  } catch (error) {
    sendChunkedError(res, error);
  }
});

router.delete('/uploads/:id', async (req, res) => {
  await cancelChunkedUpload(req.params.id);
  res.json({ ok: true });
});

/**
 * Serves one stored image asset by filename. Only files directly inside the
 * global assets folder are reachable; traversal attempts resolve to null.
 */
router.get('/images/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.setHeader('Content-Type', asset.contentType);
  // Stored-XSS hardening: never let the browser sniff a different type, and
  // force SVGs (which can carry scripts when rendered as a document) to
  // download instead of rendering inline. The chat UI is unaffected — it
  // fetches assets as blobs and shows them through <img>, where SVG scripts
  // never execute.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!/^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(asset.contentType)) {
    res.setHeader('Content-Disposition', 'attachment');
  }
  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error('Error streaming image asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

/**
 * Downloads one stored non-image attachment. Content-Disposition prevents
 * uploaded HTML or other active formats from rendering in the application.
 */
router.get('/files/:filename', async (req, res) => {
  const asset = await openStoredAttachmentAsset(req.params.filename);
  if (asset.status === 'invalid') {
    return res.status(400).json({ error: 'Invalid asset filename' });
  }
  if (asset.status === 'missing') {
    return res.status(404).json({ error: 'Asset not found' });
  }

  res.setHeader('Content-Type', asset.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // RFC 5987: header values must be latin1-safe, so non-ASCII names go in filename*.
  const asciiName = req.params.filename.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(req.params.filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
  );
  asset.stream.pipe(res);
  asset.stream.on('error', (error) => {
    console.error('Error streaming attachment asset:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Error reading asset' });
    }
  });
});

export default router;
