const multer = require('multer');
const path = require('path');
const fs = require('fs');

const uploadsRoot = path.join(__dirname, '..', '..', 'uploads');
const incidentDir = path.join(uploadsRoot, 'incidents');
const pdfDir = path.join(uploadsRoot, 'pdf-imports');
const missingDir = path.join(uploadsRoot, 'missing');
for (const d of [incidentDir, pdfDir, missingDir]) fs.mkdirSync(d, { recursive: true });

function imageStorage(dir) {
  return multer.diskStorage({
    destination: (req, file, cb) => cb(null, dir),
    filename: (req, file, cb) => {
      const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, unique + ext);
    }
  });
}

const incidentUpload = multer({
  storage: imageStorage(incidentDir),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      const err = new Error('Only image files are allowed.');
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

const missingUpload = multer({
  storage: imageStorage(missingDir),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      const err = new Error('Only image files are allowed.');
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

const pdfUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, pdfDir),
    filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + '.pdf')
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf' && !/\.pdf$/i.test(file.originalname)) {
      const err = new Error('Only PDF files are allowed.');
      err.statusCode = 400;
      return cb(err);
    }
    cb(null, true);
  }
});

module.exports = { incidentUpload, missingUpload, pdfUpload };
