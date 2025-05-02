// src/utils/blob.ts

/**
 * Converts a Blob object to a Base64 encoded string.
 * @param blob The Blob to convert.
 * @returns A promise that resolves with the Base64 string (including the data URL prefix).
 */
export function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            // result contains the data as a data: URL string
            resolve(reader.result as string);
        };
        reader.readAsDataURL(blob);
    });
}