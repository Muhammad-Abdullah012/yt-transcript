import { GEMINI_API_URL } from "@/constants/keys";
import { GeminiRequest } from "@/interfaces";

/**
 * Calls the Gemini API to generate content.
 *
 * @param apiKey Your Gemini API key.  Ensure this is securely managed (e.g., environment variable).
 * @param modelId The ID of the Gemini model to use (e.g., "gemini-2.0-flash").
 * @param inputText The text input for the Gemini model.
 * @returns A promise that resolves to the generated text content, or rejects with an error.
 * @throws Error if the API key is missing or if the fetch request fails.
 */
export async function generateContentWithGemini(
  apiKey: string,
  inputText: string,
  targetLanguage: string,
  modelId: string = "gemini-2.0-flash"
): Promise<string> {
  if (!apiKey) {
    throw new Error("Gemini API key is required.");
  }

  const apiUrl = `${GEMINI_API_URL}/${modelId}:generateContent?key=${apiKey}`;

  const prompt = `Translate the following text to ${targetLanguage}. Output only the translated text, without any introductory phrases or explanations or addition to text:\n\n"${inputText}"`;

  const requestBody: GeminiRequest = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      responseMimeType: "text/plain",
    },
  };

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorMessage = `Gemini API request failed with status ${response.status}`;
      try {
        const errorBody = await response.json();
        errorMessage += `: ${JSON.stringify(errorBody)}`;
      } catch (e) {
        errorMessage += ": Could not parse error body.";
      }
      throw new Error(errorMessage);
    }

    const responseBody = await response.json();
    const text = responseBody?.candidates?.[0]?.content?.parts?.[0]?.text;

    return text || "No content generated.";
  } catch (error) {
    console.error("Error calling Gemini API:", error);
    throw error;
  }
}
