import { GoogleGenAI, Type, FunctionDeclaration } from "@google/genai";
import { Persona, Message } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

const generateImageTool: FunctionDeclaration = {
  name: "generate_image",
  parameters: {
    type: Type.OBJECT,
    description: "Generate an image based on a detailed text description.",
    properties: {
      prompt: {
        type: Type.STRING,
        description: "A detailed description of the image to generate.",
      },
    },
    required: ["prompt"],
  },
};

export async function chatWithAI(
  messages: Message[],
  persona: Persona,
  onImageGenerated?: (imageUrl: string) => void
): Promise<string> {
  const systemInstruction = `
    You are ${persona.name}. 
    Personality: ${persona.description}
    
    Instructions: ${persona.systemPrompt}
    
    Custom Q&A Knowledge (STRICT ADHERENCE REQUIRED):
    ${persona.qaPairs.map(pair => `Q: ${pair.question}\nA: ${pair.answer}${pair.imageUrls && pair.imageUrls.length > 0 ? ` [IMAGES_ATTACHED: ${pair.imageUrls.length} images]` : ''}`).join('\n\n')}
    
    STRICT RULES:
    1. If the user's input matches or is very similar to a question in the "Custom Q&A Knowledge", you MUST provide the EXACT answer provided in that Q&A. Do not add, remove, or change any words.
    2. If the Q&A has [IMAGES_ATTACHED], you MUST mention that you are showing them photos.
    3. If the user's input does NOT match any Custom Q&A, then you may answer based on your persona and general knowledge.
  `;

  const contents = messages.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: [generateImageTool] }],
      },
    });

    const functionCalls = response.functionCalls;
    if (functionCalls && functionCalls.length > 0) {
      const call = functionCalls[0];
      if (call.name === "generate_image") {
        const prompt = (call.args as any).prompt;
        const imageUrl = await generateImage(prompt);
        if (onImageGenerated) {
          onImageGenerated(imageUrl);
        }
        return `[Generated Image: ${prompt}]`;
      }
    }

    return response.text || "I'm sorry, I couldn't process that.";
  } catch (error) {
    console.error("Chat Error:", error);
    return "Error communicating with AI.";
  }
}

async function generateImage(prompt: string): Promise<string> {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: [{ text: prompt }],
      },
      config: {
        imageConfig: {
          aspectRatio: "1:1",
          imageSize: "1K"
        },
      },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    throw new Error("No image data returned");
  } catch (error) {
    console.error("Image Generation Error:", error);
    // Fallback to a placeholder if generation fails
    return `https://picsum.photos/seed/${encodeURIComponent(prompt)}/1024/1024`;
  }
}
