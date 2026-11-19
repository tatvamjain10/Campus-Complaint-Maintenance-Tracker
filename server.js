const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const UPLOAD_DIR = path.join(PUBLIC_DIR, 'uploads');
const ROLES = ['Student', 'Staff'];
const CATEGORIES = ['Broken Lights', 'Plumbing', 'Lab Fault', 'Other'];
const STATUSES = ['Pending', 'In Progress', 'Resolved'];
const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};


fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- Database ----------
const db = new sqlite3.Database(path.join(__dirname, 'campus.db'), (err) => {
  if (err) {
    console.error('Failed to open database:', err.message);
    process.exit(1);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reporter_name TEXT NOT NULL,
      reporter_role TEXT NOT NULL CHECK (reporter_role IN ('Student', 'Staff')),
      department_location TEXT NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('Broken Lights', 'Plumbing', 'Lab Fault', 'Other')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      photo_path TEXT,
      status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'In Progress', 'Resolved')),
      admin_note TEXT,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `, (err) => {
    if (err) {
      console.error('Failed to create table:', err.message);
      process.exit(1);
    }
  });
});

const dbRun = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });

const dbGet = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });

const dbAll = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });

// ---------- Upload handling ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = MIME_TO_EXT[file.mimetype] || '';
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `complaint-${unique}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (MIME_TO_EXT[file.mimetype]) return cb(null, true);
    const err = new Error('Only JPG, PNG, GIF, or WEBP images are allowed.');
    err.status = 400;
    cb(err);
  },
});

const removeUploadedFile = (photoPath) => {
  if (!photoPath) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(photoPath));
  fs.unlink(filePath, () => {});
};

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

// ---------- App ----------
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));

// Create a complaint
app.post('/api/complaints', upload.single('photo'), async (req, res, next) => {
  const photoPath = req.file ? `/uploads/${req.file.filename}` : null;
  try {
    const reporter_name = clean(req.body.reporter_name);
    const reporter_role = clean(req.body.reporter_role);
    const department_location = clean(req.body.department_location);
    const category = clean(req.body.category);
    const title = clean(req.body.title);
    const description = clean(req.body.description);

    const errors = [];
    if (!reporter_name) errors.push('reporter_name is required.');
    if (!ROLES.includes(reporter_role)) errors.push(`reporter_role must be one of: ${ROLES.join(', ')}.`);
    if (!department_location) errors.push('department_location is required.');
    if (!CATEGORIES.includes(category)) errors.push(`category must be one of: ${CATEGORIES.join(', ')}.`);
    if (!title) errors.push('title is required.');
    if (!description) errors.push('description is required.');

    if (errors.length) {
      removeUploadedFile(photoPath);
      return res.status(400).json({ error: 'Validation failed.', details: errors });
    }

    const result = await dbRun(
      `INSERT INTO complaints
        (reporter_name, reporter_role, department_location, category, title, description, photo_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [reporter_name, reporter_role, department_location, category, title, description, photoPath]
    );

    const created = await dbGet('SELECT * FROM complaints WHERE id = ?', [result.lastID]);
    res.status(201).json(created);
  } catch (err) {
    removeUploadedFile(photoPath);
    next(err);
  }
});

// List complaints (optional ?status= and ?category=), newest first
app.get('/api/complaints', async (req, res, next) => {
  try {
    const status = clean(req.query.status);
    const category = clean(req.query.category);

    if (status && !STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });
    }
    if (category && !CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `category must be one of: ${CATEGORIES.join(', ')}.` });
    }

    const conditions = [];
    const params = [];
    if (status) {
      conditions.push('status = ?');
      params.push(status);
    }
    if (category) {
      conditions.push('category = ?');
      params.push(category);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = await dbAll(
      `SELECT * FROM complaints ${where} ORDER BY created_at DESC, id DESC`,
      params
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// Update status and/or admin note
app.patch('/api/complaints/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid complaint id.' });
    }

    const body = req.body || {};
    const sets = [];
    const params = [];

    if (body.status !== undefined) {
      const status = clean(body.status);
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}.` });
      }
      sets.push('status = ?');
      params.push(status);
    }

    if (body.admin_note !== undefined) {
      if (body.admin_note !== null && typeof body.admin_note !== 'string') {
        return res.status(400).json({ error: 'admin_note must be a string.' });
      }
      sets.push('admin_note = ?');
      params.push(body.admin_note === null ? null : body.admin_note.trim());
    }

    if (!sets.length) {
      return res.status(400).json({ error: 'Provide status and/or admin_note to update.' });
    }

    const existing = await dbGet('SELECT id FROM complaints WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }

    params.push(id);
    await dbRun(`UPDATE complaints SET ${sets.join(', ')} WHERE id = ?`, params);

    const updated = await dbGet('SELECT * FROM complaints WHERE id = ?', [id]);
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// Delete a complaint (and its photo)
app.delete('/api/complaints/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid complaint id.' });
    }

    const existing = await dbGet('SELECT id, photo_path FROM complaints WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ error: 'Complaint not found.' });
    }

    await dbRun('DELETE FROM complaints WHERE id = ?', [id]);
    removeUploadedFile(existing.photo_path);
    res.json({ message: 'Complaint deleted.', id });
  } catch (err) {
    next(err);
  }
});

// Unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// Central error handler
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE'
      ? 'Image is too large. Maximum size is 5 MB.'
      : err.message;
    return res.status(400).json({ error: message });
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body.' });
  }

  if (err.status && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }

  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ---------- Start ----------
const server = app.listen(PORT, () => {
  console.log(`Campus Complaint Tracker running at http://localhost:${PORT}`);
});

const shutdown = () => {
  server.close(() => {
    db.close(() => process.exit(0));
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
