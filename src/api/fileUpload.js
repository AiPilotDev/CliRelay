import fs from 'fs';
import path from 'path';
import { logError } from '../logger/index.js';

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];
const DOCUMENT_EXTENSIONS = ['.pdf', '.doc', '.docx', '.txt'];
const DEFAULT_FILE_TYPE = 'file';
const IMAGE_FILE_TYPE = 'image';
const DOCUMENT_FILE_TYPE = 'document';

function disabledUploadError() {
    return new Error('File upload to Qwen is not available in browserless proxy mode yet.');
}

export async function getStsToken() {
    throw disabledUploadError();
}

export async function uploadFile() {
    throw disabledUploadError();
}

export async function uploadFileToQwen(filePath) {
    try {
        if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

        const fileName = path.basename(filePath);
        const fileSize = fs.statSync(filePath).size;
        const fileExt = path.extname(fileName).toLowerCase();

        let fileType = DEFAULT_FILE_TYPE;
        if (IMAGE_EXTENSIONS.includes(fileExt)) fileType = IMAGE_FILE_TYPE;
        else if (DOCUMENT_EXTENSIONS.includes(fileExt)) fileType = DOCUMENT_FILE_TYPE;

        return {
            success: false,
            error: disabledUploadError().message,
            fileInfo: { filename: fileName, filesize: fileSize, filetype: fileType }
        };
    } catch (error) {
        logError(`File upload failed: ${error.message}`, error);
        return { success: false, error: error.message };
    }
}

export default { getStsToken, uploadFile, uploadFileToQwen };
