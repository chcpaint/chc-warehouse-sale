const multer = require('multer');
const path = require('path');

const ALLOWED_CATALOG_TYPES = ['.csv', '.xlsx', '.xls', '.pdf'];
const ALLOWED_IMAGE_TYPES = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
const MAX_CATALOG_SIZE = parseInt(process.env.MAX_CATALOG_SIZE) || 10 * 1024 * 1024; // 10MB
const MAX_LOGO_SIZE = parseInt(process.env.MAX_LOGO_SIZE) || 2 * 1024 * 1024; // 2MB

const catalogStorage = multer.memoryStorage();

const catalogUpload = multer({
    storage: catalogStorage,
    limits: { fileSize: MAX_CATALOG_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_CATALOG_TYPES.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Invalid file type. Allowed: ${ALLOWED_CATALOG_TYPES.join(', ')}`));
        }
    }
});

const logoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_LOGO_SIZE },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (ALLOWED_IMAGE_TYPES.includes(ext)) {
            cb(null, true);
        } else {
            cb(new Error(`Invalid image type. Allowed: ${ALLOWED_IMAGE_TYPES.join(', ')}`));
        }
    }
});

module.exports = { catalogUpload, logoUpload };
