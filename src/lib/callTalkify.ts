import { TALKIFY_TTS_API_URL } from "@/constants/keys";
import { blobToBase64 } from "./blobToBase64";

/**
 * Converts text to speech using the Talkify API.
 *
 * @param apiKey Your Talkify API key (retrieved securely).
 * @param text The text to synthesize.
 * @param voice Optional: Specify a Talkify voice/language code (e.g., 'Microsoft David - English (United States)'). Check Talkify docs for available voices.
 * @param format The desired audio format (e.g., 'wav', 'mp3'). Defaults to 'wav'.
 * @returns A promise that resolves to the base64 encoded audio string, or rejects with an error.
 * @throws Error if the API key or text is missing, or if the fetch request fails.
 */
export async function textToSpeechTalkify(
    apiKey: string,
    text: string,
    format: 'wav' | 'mp3' = 'wav'
): Promise<string> {
    if (!apiKey) {
        throw new Error("Talkify API key is required.");
    }
    if (!text || text.trim().length === 0) {
        console.warn("Talkify called with empty text.");
        // Return a very short silent WAV file in base64 to avoid breaking audio playback logic
        // This represents ~0.05s of silence
        return "UklGRiYAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAA=";
        // Alternatively, throw an error or return empty string if the caller handles it:
        // return "";
    }

    const params = new URLSearchParams({
        text: text,
        format: format,
    });

    const apiUrl = `${TALKIFY_TTS_API_URL}?${params.toString()}`;

    try {
        const response = await fetch(apiUrl, {
            method: "GET",
            headers: {
                "x-api-key": apiKey,
            },
        });

        if (!response.ok) {
            let errorMessage = `Talkify API request failed with status ${response.status}`;
            try {
                const errorBody = await response.text();
                errorMessage += `: ${errorBody}`;
            } catch (e) {
                errorMessage += ": Could not read error body.";
            }
            console.error(errorMessage);
            throw new Error(errorMessage);
        }

        // Get the audio data as a Blob
        const audioBlob = await response.blob();

        if (audioBlob.size === 0) {
            throw new Error("Talkify returned an empty audio blob.");
        }

        // Convert Blob to Base64
        const base64Audio = await blobToBase64(audioBlob);
        return base64Audio;

    } catch (error) {
        console.error("Error calling Talkify API:", error);
        throw error instanceof Error ? error : new Error(String(error));
    }
}