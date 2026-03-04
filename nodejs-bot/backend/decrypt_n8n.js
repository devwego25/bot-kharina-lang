
const crypto = require('crypto');

// Inputs
const encryptionKey = '100c4fa5b3f16e2567f7b8966b42904e'; // From docker inspect
const encryptedData = 'U2FsdGVkX1+tDcrYJJdKvVsEj1eq5TVlj1IRNQA4hx5Jg4cRdi2Cft3e63Yfud4Kqj7UJSHeftUlLn0QFPoAIjNUHlX+bvKCucLJXJP/xoWCLC0pVXqpWEP84hTZSemy'; // From DB query (httpBearerAuth)

function decrypt(encryptedData, encryptionKey) {
    try {
        // n8n format: Salted__ + salt (8 bytes) + IV (12 or 16 bytes?) + AuthTag (16 bytes) + Ciphertext ??? 
        // Actually n8n uses a specific format. Let's try standard AES-256-CBC first as older n8n used it, 
        // but new n8n uses AES-256-GCM.
        // Wait, the data starts with "Salted__". This is OpenSSL format?
        // Let's try to decipher using standard crypto patterns used by n8n.

        // N8n v1 encryption logic:
        // It uses 'aes-256-ctr' or 'aes-256-cbc' often with a derived key.
        // But "Salted__" strongly suggests the OpenSSL format provided by `crypto-js` which n8n used/uses.

        // Let's try to decode using the logic often found in n8n's source or compatible decryptors.
        // Actually, since I am an AI, I can try to simulate the n8n decryption.
        // Better yet, I can write a script that tries the common n8n cipher.

        // However, "Salted__" is definitely CryptoJS.
        // I will use a library if possible or manual derivation.
        // Manual derivation (OpenSSL KDF):
        // 1. Get salt (bytes 8-16)
        // 2. Derive Key and IV from Passphrase + Salt (MD5 usually for OpenSSL legacy, or PBKDF2)
        // 3. Decrypt AES.

        // Simplest way: The user might have `n8n` installed locally? No.
        // I will write a script that mimics CryptoJS decryption using standard 'crypto' module.

        const buffer = Buffer.from(encryptedData, 'base64');
        const salt = buffer.slice(8, 16);
        const ciphertext = buffer.slice(16);

        // Derive Key and IV (OpenSSL compatible)
        // N8n uses the encryption key as the passphrase.

        // Function to derive key and IV (EVP_BytesToKey equivalent)
        function deriveKeyAndIV(password, salt, keyLen, ivLen) {
            let dt = Buffer.alloc(0);
            let result = Buffer.alloc(0);
            while (result.length < keyLen + ivLen) {
                const hash = crypto.createHash('md5');
                hash.update(dt);
                hash.update(password);
                hash.update(salt);
                dt = hash.digest();
                result = Buffer.concat([result, dt]);
            }
            return {
                key: result.slice(0, keyLen),
                iv: result.slice(keyLen, keyLen + ivLen)
            };
        }

        const { key, iv } = deriveKeyAndIV(encryptionKey, salt, 32, 16);

        // Attempt AES-256-CBC (standard for CryptoJS)
        const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(ciphertext);
        decrypted = Buffer.concat([decrypted, decipher.final()]);

        return decrypted.toString('utf8');

    } catch (error) {
        return "Decryption Failed: " + error.message;
    }
}

console.log(decrypt(encryptedData, encryptionKey));
