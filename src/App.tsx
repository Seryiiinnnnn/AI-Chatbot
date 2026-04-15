/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Send, 
  Settings, 
  Plus, 
  Trash2, 
  Image as ImageIcon, 
  User, 
  Bot, 
  MessageSquare,
  Save,
  Sparkles,
  Mic,
  MicOff,
  Volume2,
  VolumeX,
  X,
  PanelLeftClose,
  PanelLeftOpen,
  Menu
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Label } from '@/components/ui/label';
import { 
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogTitle,
  DialogHeader,
} from "@/components/ui/dialog";
import { motion, AnimatePresence } from 'motion/react';
import { chatWithAI } from './lib/gemini';
import { Persona, Message, QAPair } from './types';
import { cn } from './lib/utils';
import { db, auth, googleProvider, signInWithPopup, doc, setDoc, onSnapshot } from './lib/firebase';
import { onAuthStateChanged, User as FirebaseUser } from 'firebase/auth';

// Add SpeechRecognition type for TypeScript
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  onresult: (event: SpeechRecognitionEvent) => void;
  onerror: (event: any) => void;
  onend: () => void;
}

declare global {
  interface Window {
    webkitSpeechRecognition: any;
    SpeechRecognition: any;
  }
}

const DEFAULT_PERSONA: Persona = {
  name: "智能助手",
  description: "一个友好且知识渊博的AI助手。",
  systemPrompt: "你是一个全能的AI助手，乐于助人且幽默。当用户要求看照片或图片时，请使用 generate_image 工具。",
  qaPairs: [
    { id: '1', question: "你是谁？", answer: "我是你的专属AI智能助手，很高兴为你服务！" }
  ]
};

export default function App() {
  const [persona, setPersona] = useState<Persona>(DEFAULT_PERSONA);
  const [user, setUser] = useState<FirebaseUser | null>(null);
  const [isConfigLoading, setIsConfigLoading] = useState(true);
  
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isLongPress, setIsLongPress] = useState(false);
  const [showErrorDialog, setShowErrorDialog] = useState(false);
  const [errorType, setErrorType] = useState<'not-allowed' | 'network' | 'no-mic' | null>(null);
  const isLongPressRef = useRef(false);
  const transcriptRef = useRef('');
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('chat');
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const synthesisRef = useRef<SpeechSynthesis | null>(window.speechSynthesis);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);

  // Local Storage Persistence
  useEffect(() => {
    const savedPersona = localStorage.getItem('persona_config');
    if (savedPersona) {
      try {
        setPersona(JSON.parse(savedPersona));
      } catch (e) {
        console.error("Failed to parse saved persona", e);
      }
    } else {
      // If no saved persona, we use the DEFAULT_PERSONA (factory settings)
      setPersona(DEFAULT_PERSONA);
    }
    setIsConfigLoading(false);
  }, []);

  useEffect(() => {
    if (!isConfigLoading) {
      localStorage.setItem('persona_config', JSON.stringify(persona));
    }
  }, [persona, isConfigLoading]);

  useEffect(() => {
    if (scrollRef.current) {
      const viewport = scrollRef.current.querySelector('[data-slot="scroll-area-viewport"]');
      if (viewport) {
        viewport.scrollTo({
          top: viewport.scrollHeight,
          behavior: 'smooth'
        });
      }
    }
  }, [messages, isLoading]);

  // Flexible Matching Helper
  const findMatchedQA = (text: string) => {
    const cleanText = text.replace(/[，。？！,.?!]/g, '').toLowerCase().trim();
    if (!cleanText) return null;

    // 1. Exact or Substring Match (Highest Priority)
    const directMatch = persona.qaPairs.find(qa => {
      const cleanQ = qa.question.replace(/[，。？！,.?!]/g, '').toLowerCase().trim();
      return cleanText === cleanQ || cleanText.includes(cleanQ) || cleanQ.includes(cleanText);
    });
    if (directMatch) return directMatch;

    // 2. Keyword Overlap Match (Fuzzy)
    // Split into keywords (simple split by space or common Chinese characters)
    const getKeywords = (s: string) => s.split('').filter(c => !/[的了呢吧啊吗]/.test(c));
    const textKeywords = getKeywords(cleanText);
    
    if (textKeywords.length < 2) return null;

    return persona.qaPairs.find(qa => {
      const cleanQ = qa.question.replace(/[，。？！,.?!]/g, '').toLowerCase().trim();
      const qKeywords = getKeywords(cleanQ);
      
      // Calculate overlap
      const intersection = qKeywords.filter(k => textKeywords.includes(k));
      const overlapRatio = intersection.length / qKeywords.length;
      
      // If more than 70% of the predefined question's keywords are present in the user's input
      return overlapRatio >= 0.7;
    });
  };

  // Initialize Speech Recognition
  useEffect(() => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = 'zh-CN';

      recognition.onresult = (event: SpeechRecognitionEvent) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const transcript = (finalTranscript || interimTranscript).trim();
        if (!transcript) return;

        transcriptRef.current = transcript;
        setInput(transcript);
        
        // Smart Matching: Check if the recognized speech matches any custom question
        const matchedQA = findMatchedQA(transcript);

        if (matchedQA && event.results[event.results.length - 1].isFinal) {
          const matchedQuestion = matchedQA.question;
          transcriptRef.current = ''; // Clear immediately to prevent double-send in onend
          setInput(matchedQuestion);
          // Small delay to let the user see the text before sending
          setTimeout(() => {
            handleSend(matchedQuestion);
          }, 500);
          recognitionRef.current?.stop();
        }
      };

      recognition.onerror = (event: any) => {
        console.error('Speech recognition error', event.error);
        setIsListening(false);
        isLongPressRef.current = false;
        
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
          setErrorType('not-allowed');
          setShowErrorDialog(true);
        } else if (event.error === 'no-speech') {
          // Ignore no-speech errors to avoid annoying the user
        } else if (event.error === 'network') {
          setErrorType('network');
          setShowErrorDialog(true);
        }
      };

      recognition.onend = () => {
        setIsListening(false);
        // If it was a long press, auto-send the result
        if (isLongPressRef.current && transcriptRef.current.trim()) {
          handleSend(transcriptRef.current);
        }
        isLongPressRef.current = false;
      };

      recognitionRef.current = recognition;
    }
  }, []);

  const toggleListening = async (isLongPressMode = false) => {
    if (isListening) {
      recognitionRef.current?.stop();
    } else {
      if (!recognitionRef.current) {
        setErrorType('no-mic');
        setShowErrorDialog(true);
        return;
      }

      // Proactively check for microphone access if possible
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          stream.getTracks().forEach(track => track.stop()); // Stop immediately, we just wanted to check
        }
      } catch (err: any) {
        if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
          setErrorType('not-allowed');
          setShowErrorDialog(true);
          return;
        }
      }

      try {
        transcriptRef.current = '';
        isLongPressRef.current = isLongPressMode;
        recognitionRef.current.start();
        setIsListening(true);
      } catch (e) {
        console.error('Recognition already started', e);
      }
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    // Prevent default to avoid ghost clicks but allow scrolling if needed
    // For a button, we usually want to prevent default
    longPressTimer.current = setTimeout(() => {
      setIsLongPress(true);
      if (!isListening) toggleListening(true);
    }, 400); // Slightly faster long press
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (longPressTimer.current) clearTimeout(longPressTimer.current);
    if (isLongPress) {
      setIsLongPress(false);
      if (isListening) {
        recognitionRef.current?.stop();
      }
    }
  };

  const handleSend = async (overrideInput?: string) => {
    const messageContent = (overrideInput || input).trim();
    if (!messageContent || isLoading) return;
    
    // Prevent duplicate sends of the exact same content in rapid succession
    // (especially common with voice recognition onend + matchedQA triggers)
    if (messages.length > 0 && 
        messages[messages.length - 1].role === 'user' && 
        messages[messages.length - 1].content === messageContent &&
        Date.now() - messages[messages.length - 1].timestamp < 1000) {
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: messageContent,
      timestamp: Date.now()
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    transcriptRef.current = '';
    // Use a local variable for isLoading to avoid race conditions in the UI
    setIsLoading(true);

    try {
      let assistantImageUrls: string[] = [];
      let forcedResponse: string | undefined;
      
      // Check if the input matches a custom Q&A with images (using fuzzy matching)
      const matchedQA = findMatchedQA(messageContent);
      
      if (matchedQA) {
        assistantImageUrls = matchedQA.imageUrls || [];
        forcedResponse = matchedQA.answer;
      }

      const responseText = forcedResponse || await chatWithAI(
        [...messages, userMessage], 
        persona,
        (url) => { 
          // Only override if not already set by custom QA
          if (assistantImageUrls.length === 0) assistantImageUrls = [url]; 
        }
      );

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: responseText,
        imageUrls: assistantImageUrls.length > 0 ? assistantImageUrls : undefined,
        timestamp: Date.now()
      };

      setMessages(prev => [...prev, assistantMessage]);
      
      // Auto-read if requested or if it's a direct answer
      if (responseText) {
        speak(responseText);
      }
    } catch (error) {
      console.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  const speak = (text: string) => {
    if (!synthesisRef.current) return;
    
    // Stop any current speech
    synthesisRef.current.cancel();
    
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'zh-CN';
    utterance.onstart = () => setIsSpeaking(true);
    utterance.onend = () => setIsSpeaking(false);
    utterance.onerror = () => setIsSpeaking(false);
    
    utteranceRef.current = utterance;
    synthesisRef.current.speak(utterance);
  };

  const stopSpeaking = () => {
    synthesisRef.current?.cancel();
    setIsSpeaking(false);
  };

  const addQAPair = () => {
    const newPair: QAPair = { id: Date.now().toString(), question: '', answer: '' };
    setPersona(prev => ({ ...prev, qaPairs: [...prev.qaPairs, newPair] }));
  };

  const updateQAPair = (id: string, field: keyof QAPair, value: string) => {
    setPersona(prev => ({
      ...prev,
      qaPairs: prev.qaPairs.map(p => p.id === id ? { ...p, [field]: value } : p)
    }));
  };

  const handleImageUpload = (id: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files && files.length > 0) {
      const currentQA = persona.qaPairs.find(p => p.id === id);
      const currentImages = currentQA?.imageUrls || [];
      
      if (currentImages.length >= 6) {
        alert('每个问答对最多只能上传 6 张照片。');
        return;
      }

      const filesToUpload = Array.from(files).slice(0, 6 - currentImages.length);
      let uploadedCount = 0;
      const newBase64Images: string[] = [];

      filesToUpload.forEach(file => {
        const reader = new FileReader();
        reader.onloadend = () => {
          newBase64Images.push(reader.result as string);
          uploadedCount++;
          
          // Only update state once all images are processed to prevent "flickering" or crashes
          if (uploadedCount === filesToUpload.length) {
            setPersona(prev => ({
              ...prev,
              qaPairs: prev.qaPairs.map(p => {
                if (p.id === id) {
                  return { ...p, imageUrls: [...(p.imageUrls || []), ...newBase64Images] };
                }
                return p;
              })
            }));
          }
        };
        reader.readAsDataURL(file as Blob);
      });
    }
  };

  const removeImage = (qaId: string, index: number) => {
    setPersona(prev => ({
      ...prev,
      qaPairs: prev.qaPairs.map(p => {
        if (p.id === qaId && p.imageUrls) {
          const newImages = p.imageUrls.filter((_, i) => i !== index);
          return { ...p, imageUrls: newImages };
        }
        return p;
      })
    }));
  };

  const removeQAPair = (id: string) => {
    setPersona(prev => ({
      ...prev,
      qaPairs: prev.qaPairs.filter(p => p.id !== id)
    }));
  };

  return (
    <div className="flex h-screen bg-neutral-50 text-neutral-900 font-sans overflow-hidden relative">
      {/* Error Dialog for Speech Recognition */}
      <Dialog open={showErrorDialog} onOpenChange={setShowErrorDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-red-600">
              <MicOff className="w-5 h-5" />
              {errorType === 'not-allowed' ? '麦克风访问受限' : 
               errorType === 'network' ? '网络连接错误' : '功能不受支持'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="text-sm text-neutral-600 leading-relaxed">
              {errorType === 'not-allowed' ? (
                <>
                  检测到麦克风权限被拒绝。这通常是因为：
                  <ul className="list-disc list-inside mt-2 space-y-1">
                    <li>您在浏览器弹窗中点击了“拒绝”</li>
                    <li>浏览器设置中禁用了此网站的麦克风访问</li>
                    <li>由于安全策略，iFrame 内的语音功能被限制</li>
                  </ul>
                  <div className="mt-4 p-3 bg-indigo-50 rounded-lg text-indigo-700 font-medium">
                    💡 建议：点击右上角“在新标签页打开”图标，在独立页面中重新尝试。
                  </div>
                </>
              ) : errorType === 'network' ? (
                '语音识别需要稳定的网络连接，请检查您的网络设置后重试。'
              ) : (
                '您的浏览器似乎不支持 Web Speech API。建议使用 Chrome、Edge 或 Safari 浏览器。'
              )}
            </div>
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setShowErrorDialog(false)} className="bg-indigo-600 hover:bg-indigo-700">
              我知道了
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Mobile Overlay for Sidebar */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/20 backdrop-blur-sm z-20 md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar for Settings */}
      <AnimatePresence mode="wait">
        {isSidebarOpen && (
          <motion.aside 
            initial={{ x: -320, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: -320, opacity: 0 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="w-[85vw] md:w-80 border-r bg-white flex flex-col shadow-xl md:shadow-sm h-full z-30 absolute md:relative"
          >
            <div className="p-6 border-b flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="bg-indigo-600 p-2 rounded-lg">
                  <Sparkles className="w-5 h-5 text-white" />
                </div>
                <h1 className="text-xl font-bold tracking-tight">AI Persona Studio</h1>
              </div>
              <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(false)} className="md:hidden">
                <X className="w-5 h-5" />
              </Button>
            </div>
            
            <div className="flex-1 overflow-y-auto px-6 pb-6 custom-scrollbar">
          <div className="space-y-8 py-4">
            <section className="space-y-4">
              <div className="flex items-center gap-2 text-indigo-600 font-semibold text-sm uppercase tracking-wider">
                <Settings className="w-4 h-4" />
                <span>基本设定</span>
              </div>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label htmlFor="name">AI 名称</Label>
                  <Input 
                    id="name" 
                    value={persona.name} 
                    onChange={e => {
                      setPersona(prev => ({ ...prev, name: e.target.value }));
                    }}
                    placeholder="例如：小智"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="desc">性格描述</Label>
                  <Input 
                    id="desc" 
                    value={persona.description} 
                    onChange={e => {
                      setPersona(prev => ({ ...prev, description: e.target.value }));
                    }}
                    placeholder="例如：活泼开朗、乐于助人"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="prompt">系统指令 (System Prompt)</Label>
                  <Textarea 
                    id="prompt" 
                    rows={4}
                    value={persona.systemPrompt} 
                    onChange={e => {
                      setPersona(prev => ({ ...prev, systemPrompt: e.target.value }));
                    }}
                    placeholder="告诉AI它应该如何表现..."
                    className="resize-none"
                  />
                </div>
              </div>
            </section>

            <Separator />

            <section className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-indigo-600 font-semibold text-sm uppercase tracking-wider">
                  <MessageSquare className="w-4 h-4" />
                  <span>自定义 Q&A</span>
                </div>
                <Button variant="ghost" size="icon" onClick={addQAPair} className="h-8 w-8 text-indigo-600">
                  <Plus className="w-4 h-4" />
                </Button>
              </div>
              
              <div className="space-y-4">
                {persona.qaPairs.map((pair) => (
                  <Card key={pair.id} className="border-neutral-200 shadow-none bg-neutral-50/50">
                    <CardContent className="p-3 space-y-2">
                      <div className="flex justify-between items-center">
                        <Badge variant="outline" className="text-[10px] uppercase font-bold">问答对</Badge>
                        <Button variant="ghost" size="icon" onClick={() => removeQAPair(pair.id)} className="h-6 w-6 text-red-500 hover:text-red-600 hover:bg-red-50">
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                      <Input 
                        placeholder="问题..." 
                        value={pair.question}
                        onChange={e => updateQAPair(pair.id, 'question', e.target.value)}
                        className="h-8 text-sm bg-white"
                      />
                      <Textarea 
                        placeholder="回答..." 
                        value={pair.answer}
                        onChange={e => updateQAPair(pair.id, 'answer', e.target.value)}
                        className="text-sm bg-white resize-none"
                        rows={2}
                      />
                      
                      <div className="space-y-2">
                        <Label className="text-[10px] text-neutral-500 uppercase font-bold">关联照片 (最多6张)</Label>
                        <div className="grid grid-cols-3 gap-2">
                          {pair.imageUrls?.map((url, idx) => (
                            <div key={idx} className="relative group rounded-lg overflow-hidden border border-neutral-200 aspect-square">
                              <img src={url} alt={`QA ${idx}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              <Button 
                                variant="destructive" 
                                size="icon" 
                                className="absolute top-1 right-1 h-5 w-5 opacity-0 group-hover:opacity-100 transition-opacity"
                                onClick={() => removeImage(pair.id, idx)}
                              >
                                <X className="w-3 h-3" />
                              </Button>
                            </div>
                          ))}
                          {(pair.imageUrls?.length || 0) < 6 && (
                            <div className="flex items-center justify-center">
                              <Input 
                                type="file" 
                                accept="image/*" 
                                multiple
                                className="hidden" 
                                id={`file-${pair.id}`}
                                onChange={(e) => handleImageUpload(pair.id, e)}
                              />
                              <Button 
                                variant="outline" 
                                size="icon" 
                                className="w-full aspect-square border-dashed border-indigo-200 text-indigo-600 hover:bg-indigo-50"
                                onClick={() => document.getElementById(`file-${pair.id}`)?.click()}
                              >
                                <Plus className="w-4 h-4" />
                              </Button>
                            </div>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </section>
          </div>
        </div>
        
        <div className="p-4 border-t bg-neutral-50/80 space-y-2">
          <Button variant="outline" className="w-full border-neutral-200" onClick={() => setIsSidebarOpen(false)}>
            完成设置
          </Button>
          <p className="text-[10px] text-center text-neutral-400">
            设置已自动保存至本地
          </p>
        </div>
      </motion.aside>
      )}
      </AnimatePresence>

      {/* Main Chat Area */}
      <main className="flex-1 flex flex-col relative bg-white min-w-0 overflow-hidden">
        <header className="h-14 md:h-16 border-b flex items-center justify-between px-4 md:px-8 bg-white/80 backdrop-blur-md sticky top-0 z-10">
          <div className="flex items-center gap-2 md:gap-3">
            {!isSidebarOpen && (
              <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(true)} className="text-indigo-600 hover:bg-indigo-50">
                <PanelLeftOpen className="w-5 h-5 md:w-6 md:h-6" />
              </Button>
            )}
            {isSidebarOpen && (
              <Button variant="ghost" size="icon" onClick={() => setIsSidebarOpen(false)} className="hidden md:flex text-neutral-400 hover:text-indigo-600">
                <PanelLeftClose className="w-5 h-5 md:w-6 md:h-6" />
              </Button>
            )}
            <div className="w-8 h-8 md:w-10 md:h-10 rounded-full bg-indigo-100 flex items-center justify-center text-indigo-600">
              <Bot className="w-5 h-5 md:w-6 md:h-6" />
            </div>
            <div className="min-w-0">
              <h2 className="font-bold text-sm md:text-lg leading-tight truncate">{persona.name}</h2>
              <p className="text-[10px] md:text-xs text-neutral-500 truncate">{persona.description}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {isSpeaking && (
              <Button variant="ghost" size="icon" onClick={stopSpeaking} className="h-7 w-7 md:h-8 md:w-8 text-red-500 animate-pulse">
                <VolumeX className="w-4 h-4" />
              </Button>
            )}
          </div>
        </header>

        <ScrollArea className="flex-1 min-h-0" ref={scrollRef} type="auto">
          <div className="max-w-3xl mx-auto p-4 md:p-8 pb-32 space-y-6">
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center space-y-4">
                <div className="w-16 h-16 bg-indigo-50 rounded-2xl flex items-center justify-center text-indigo-600 mb-2">
                  <Sparkles className="w-8 h-8" />
                </div>
                <h3 className="text-xl font-bold">开始与你的 AI 助手对话</h3>
                <p className="text-neutral-500 max-w-xs">
                  你可以询问任何问题，或者让它为你生成一张照片。
                </p>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={() => setInput("你好，介绍一下你自己")}>
                    介绍你自己
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setInput("帮我画一张赛博朋克风格的猫")}>
                    画一张照片
                  </Button>
                </div>
              </div>
            )}
            
            <AnimatePresence initial={false}>
              {messages.map((msg) => (
                <motion.div
                  key={msg.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex gap-4",
                    msg.role === 'user' ? "flex-row-reverse" : "flex-row"
                  )}
                >
                  <div className={cn(
                    "w-7 h-7 md:w-8 md:h-8 rounded-full flex items-center justify-center flex-shrink-0 mt-1 shadow-sm",
                    msg.role === 'user' ? "bg-neutral-800 text-white" : "bg-indigo-600 text-white"
                  )}>
                    {msg.role === 'user' ? <User className="w-3.5 h-3.5 md:w-4 md:h-4" /> : <Bot className="w-3.5 h-3.5 md:w-4 md:h-4" />}
                  </div>
                  <div className={cn(
                    "flex flex-col max-w-[85%] md:max-w-[80%]",
                    msg.role === 'user' ? "items-end" : "items-start"
                  )}>
                    <div className={cn(
                      "px-3 py-2 md:px-4 md:py-3 rounded-2xl shadow-sm border",
                      msg.role === 'user' 
                        ? "bg-neutral-900 text-white border-neutral-800 rounded-tr-none" 
                        : "bg-white border-neutral-200 rounded-tl-none"
                    )}>
                      <div className="flex justify-between items-start gap-2">
                        <p className="text-sm leading-relaxed whitespace-pre-wrap flex-1">{msg.content}</p>
                        {msg.role === 'assistant' && (
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-6 w-6 text-neutral-400 hover:text-indigo-600"
                            onClick={() => speak(msg.content)}
                          >
                            <Volume2 className="w-3 h-3" />
                          </Button>
                        )}
                      </div>
                      {msg.imageUrls && msg.imageUrls.length > 0 && (
                        <motion.div 
                          initial="hidden"
                          animate="visible"
                          variants={{
                            visible: {
                              transition: {
                                staggerChildren: 0.5 // Delay between each image
                              }
                            }
                          }}
                          className={cn(
                            "mt-3 grid gap-2",
                            msg.imageUrls.length === 1 ? "grid-cols-1" : 
                            msg.imageUrls.length === 2 ? "grid-cols-2" : "grid-cols-3"
                          )}
                        >
                          {msg.imageUrls.map((url, idx) => (
                            <div key={idx}>
                              <Dialog>
                                <DialogTrigger asChild>
                                  <motion.div 
                                    variants={{
                                      hidden: { opacity: 0, scale: 0.8, y: 20 },
                                      visible: { opacity: 1, scale: 1, y: 0 }
                                    }}
                                    className="overflow-hidden rounded-xl border border-neutral-100 aspect-square shadow-sm cursor-zoom-in group relative"
                                  >
                                    <img 
                                      src={url} 
                                      alt={`AI Generated ${idx}`} 
                                      className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                                      referrerPolicy="no-referrer"
                                    />
                                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors flex items-center justify-center">
                                      <ImageIcon className="text-white opacity-0 group-hover:opacity-100 w-6 h-6 transition-opacity" />
                                    </div>
                                  </motion.div>
                                </DialogTrigger>
                                <DialogContent className="max-w-[95vw] max-h-[95vh] p-0 border-none bg-transparent shadow-none flex items-center justify-center">
                                  <DialogHeader className="sr-only">
                                    <DialogTitle>图片预览</DialogTitle>
                                  </DialogHeader>
                                  <div className="relative w-full h-full flex items-center justify-center">
                                    <img 
                                      src={url} 
                                      alt="Fullscreen Preview" 
                                      className="max-w-full max-h-[90vh] object-contain rounded-lg shadow-2xl"
                                      referrerPolicy="no-referrer"
                                    />
                                  </div>
                                </DialogContent>
                              </Dialog>
                            </div>
                          ))}
                        </motion.div>
                      )}
                    </div>
                    <span className="text-[10px] text-neutral-400 mt-1.5 font-medium uppercase tracking-tighter">
                      {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            
            {isLoading && (
              <div className="flex gap-4">
                <div className="w-8 h-8 rounded-full bg-indigo-600 text-white flex items-center justify-center animate-pulse shadow-sm">
                  <Bot className="w-4 h-4" />
                </div>
                <div className="bg-white border border-neutral-200 px-4 py-3 rounded-2xl rounded-tl-none shadow-sm">
                  <div className="flex gap-1">
                    <span className="w-1.5 h-1.5 bg-neutral-300 rounded-full animate-bounce [animation-delay:-0.3s]"></span>
                    <span className="w-1.5 h-1.5 bg-neutral-300 rounded-full animate-bounce [animation-delay:-0.15s]"></span>
                    <span className="w-1.5 h-1.5 bg-neutral-300 rounded-full animate-bounce"></span>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="p-3 md:p-6 bg-white border-t">
          <div className="max-w-3xl mx-auto relative flex gap-2">
            <div className="relative flex-1">
              <Input 
                className="pr-10 md:pr-12 py-5 md:py-6 rounded-xl md:rounded-2xl border-neutral-200 focus-visible:ring-indigo-500 shadow-sm text-base"
                placeholder={`给 ${persona.name} 发送消息...`}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
              />
              <Button 
                size="icon" 
                variant="ghost"
                className={cn(
                  "absolute right-1 md:right-2 top-1/2 -translate-y-1/2 h-8 w-8 md:h-10 md:w-10 rounded-lg md:rounded-xl transition-all duration-200",
                  isListening ? "text-red-500 bg-red-50 scale-110 shadow-inner" : "text-neutral-400 hover:text-indigo-600"
                )}
                onClick={toggleListening}
                onTouchStart={handleTouchStart}
                onTouchEnd={handleTouchEnd}
              >
                {isListening ? (
                  <div className="relative flex items-center justify-center">
                    <MicOff className="w-4 h-4 md:w-5 md:h-5 animate-pulse z-10" />
                    <span className="absolute inset-0 rounded-full bg-red-400/20 animate-ping"></span>
                  </div>
                ) : (
                  <Mic className="w-4 h-4 md:w-5 md:h-5" />
                )}
              </Button>
            </div>
            <Button 
              size="icon" 
              className="h-10 w-10 md:h-12 md:w-12 rounded-xl md:rounded-2xl bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm flex-shrink-0"
              onClick={() => handleSend()}
              disabled={!input.trim() || isLoading}
            >
              <Send className="w-4 h-4 md:w-5 md:h-5" />
            </Button>
          </div>
          <p className="text-center text-[9px] md:text-[10px] text-neutral-400 mt-2 md:mt-3 uppercase tracking-widest font-bold">
            AI Assistant
          </p>
        </div>
      </main>
    </div>
  );
}
