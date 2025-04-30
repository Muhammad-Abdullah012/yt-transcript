export const convertTranscriptionToSpeechInUserLangugage = async (transcriptions: string, language: string) => {
    console.log("transcriptions", transcriptions);
    console.log("language", language);

    const audioContent = await getDummyAudio();
    return audioContent;
}

const getDummyAudio = async () => {
    try {
        // Use chrome.runtime.getURL() to reference local files in your extension
        const audioUrl = browser.runtime.getURL('/dummy_audio.wav');

        // Fetch the WAV file as a Blob
        const response = await fetch(audioUrl);
        const blob = await response.blob();

        // Convert the Blob to base64
        const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.readAsDataURL(blob);
            reader.onload = () => {
                const dataUrl = reader.result as string;
                // Extract base64 part (after the comma)
                const base64Data = dataUrl.split(',')[1];
                resolve(base64Data);
            };
            reader.onerror = () => reject(new Error("Failed to read WAV file"));
        });

        // Return the result in the same format as Google TTS
        return { audioContent: base64 };
    } catch (error) {
        console.error("Error generating dummy audio:", error);
        throw error;
    }
}