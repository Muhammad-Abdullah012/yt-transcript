import { PublicPath } from "wxt/browser";
import { textToSpeechTalkify } from "./callTalkify";
import { generateContentWithGemini } from "./callGemini";
import { GEMINI_API_KEY, TALKIFY_API_KEY } from "@/constants/keys";

const video = "https://www.youtube.com/watch?v=uu4Rkyp8_FA";

const audioFiles = [
  "line_01_urd.wav",
  "line_02_urd.wav",
  "line_03_urd.wav",
  "line_04_urd.wav",
  "line_05_urd.wav",
  "line_06_urd.wav",
  "line_07_urd.wav",
  "line_08_urd.wav",
  "line_09_urd.wav",
  "line_10_urd.wav",
  "line_11_urd.wav",
  "line_12_urd.wav",
  "line_13_urd.wav",
  "line_14_urd.wav",
  "line_15_urd.wav",
  "line_16_urd.wav",
  "line_17_urd.wav",
  "line_18_urd.wav",
  "line_19_urd.wav",
  "line_20_urd.wav",
  "line_21_urd.wav",
  "line_22_urd.wav",
  "line_23_urd.wav",
  "line_24_urd.wav",
  "line_25_urd.wav",
  "line_26_urd.wav",
  "line_27_urd.wav",
  "line_28_urd.wav",
  "line_29_urd.wav",
  "line_30_urd.wav",
  "line_31_urd.wav",
  "line_32_urd.wav",
  "line_33_urd.wav",
  "line_34_urd.wav",
  "line_35_urd.wav",
  "line_36_urd.wav",
  "line_37_urd.wav",
  "line_38_urd.wav",
  "line_39_urd.wav",
  "line_40_urd.wav",
  "line_41_urd.wav",
  "line_42_urd.wav",
  "line_43_urd.wav",
  "line_44_urd.wav",
  // "line_45_urd.wav",
  "line_46_urd.wav",
  "line_47_urd.wav",
];

export const convertTranscriptionToSpeechInUserLangugage = async (
  transcriptions: string,
  language: string,
  i: number,
) => {
  console.log("transcriptions", transcriptions);
  console.log("language", language);

  if (!transcriptions || transcriptions.trim().length === 0 || transcriptions.trim().startsWith("[")) {
    console.log("Skipping empty transcription segment.");
    // Return silence or handle as needed
    const silentAudio = await textToSpeechTalkify("dummy_key", "", undefined);
    return { audioContent: silentAudio };
  }
  console.log(`Processing text: "${transcriptions}" for language: ${language}`);

  // try {
    
  //   console.log("Converting translated text to speech...");
  //   const audioContent = await textToSpeechTalkify(
  //     TALKIFY_API_KEY,
  //     transcriptions,
  //     "wav"
  //   );
  //   console.log(`Generated audio (base64 length: ${audioContent.length})`);
  //   return { audioContent };
  // } catch (error) {
  //   console.error(`Error processing segment "${transcriptions}":`, error);
  //   // Re-throw the error to be caught by the background script loop
  //   throw error;
  // }
  const audioContent = await getDummyAudio(i);
    return audioContent;
};
// multiple audio files for different transcription text.
const getDummyAudio = async (i: number) => {
  try {
    // Use chrome.runtime.getURL() to reference local files in your extension
    const audioUrl = browser.runtime.getURL(
      `/audio/${audioFiles[i]}` as PublicPath
    );

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
        resolve(dataUrl);
      };
      reader.onerror = () => reject(new Error("Failed to read WAV file"));
    });

    // Return the result in the same format as Google TTS
    return { audioContent: base64 };
  } catch (error) {
    console.error("Error generating dummy audio:", error);
    throw error;
  }
};
