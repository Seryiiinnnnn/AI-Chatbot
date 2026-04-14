export interface QAPair {
  id: string;
  question: string;
  answer: string;
  imageUrls?: string[];
}

export interface Persona {
  name: string;
  description: string;
  systemPrompt: string;
  qaPairs: QAPair[];
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  imageUrls?: string[];
  timestamp: number;
}
