import React, { useState, useRef, useEffect } from 'react';
import { Upload, FileText, Users, FileSignature, CheckCircle, ArrowRight, RefreshCw, Copy, Plus, Trash2, Edit2, Database, Save, X, Search, Eye, LogOut, Settings, Clock, UserPlus, Key, Download, Edit } from 'lucide-react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import { extractPeopleFromDocuments, generateDeedDraft, extractTextFromPdf } from './services/geminiService';
import { fileToBase64 } from './utils/fileUtils';

type Step = 'upload' | 'extracting' | 'roles' | 'generating' | 'result';
type Tab = 'gerar' | 'minutas' | 'usuarios' | 'configuracoes' | 'historico' | 'papeis';

interface User {
  id: number;
  username: string;
  role: 'administrador' | 'comum';
}

interface Minuta {
  id: number;
  name: string;
  description: string;
  content: string;
  ai_instructions?: string;
  created_at: string;
}

interface HistoryItem {
  id: number;
  user_id: number;
  username: string;
  minuta_name: string;
  content: string;
  created_at: string;
}

const copyRichTextToClipboard = async (element: HTMLElement, plainTextFallback: string) => {
  const htmlContent = element.innerHTML;
  const textContent = element.innerText;
  
  // Construir um HTML extremamente robusto para o Word
  // Usamos uma div com estilos inline (Word prefere inline no clipboard)
  const documentHtml = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: Arial, sans-serif; font-size: 11pt; color: #000000; text-align: justify; }
        p { margin-bottom: 12pt; }
      </style>
    </head>
    <body>
      <!--StartFragment-->
      <div style="font-family: Arial, sans-serif; font-size: 11pt; color: #000000; text-align: justify;">
        ${htmlContent}
      </div>
      <!--EndFragment-->
    </body>
    </html>
  `;

  try {
    // Tentativa 1: API Moderna de Clipboard (se o navegador/iframe permitir)
    const blobHtml = new Blob([documentHtml], { type: 'text/html' });
    const blobText = new Blob([textContent], { type: 'text/plain' });
    
    const data = [new ClipboardItem({
      'text/html': blobHtml,
      'text/plain': blobText,
    })];
    
    await navigator.clipboard.write(data);
    return true;
  } catch (err) {
    console.warn('Clipboard API falhou (provavelmente restrição de iframe), tentando fallback...', err);
    
    // Tentativa 2: Interceptação do evento de cópia + execCommand
    // Isso garante que o HTML exato seja enviado para a área de transferência, ignorando a serialização do navegador
    let successful = false;
    
    const listener = (e: ClipboardEvent) => {
      e.preventDefault();
      e.clipboardData?.setData('text/html', documentHtml);
      e.clipboardData?.setData('text/plain', textContent);
    };
    
    document.addEventListener('copy', listener);
    
    // Cria um elemento temporário apenas para ter algo selecionado
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = 'Copiando...';
    tempDiv.style.position = 'absolute';
    tempDiv.style.left = '-9999px';
    document.body.appendChild(tempDiv);
    
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(tempDiv);
    selection?.removeAllRanges();
    selection?.addRange(range);
    
    try {
      successful = document.execCommand('copy');
    } catch (execErr) {
      console.error('execCommand falhou:', execErr);
    }
    
    selection?.removeAllRanges();
    document.body.removeChild(tempDiv);
    document.removeEventListener('copy', listener);
    
    return successful;
  }
};

const downloadAsWord = (element: HTMLElement, filename: string) => {
  const html = element.innerHTML;
  const css = `
    <style>
      body { font-family: Arial, sans-serif; font-size: 11pt; color: #000000; text-align: justify; }
      p { margin-bottom: 12pt; }
      span { color: inherit; }
    </style>
  `;
  const documentHtml = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <title>${filename}</title>
      ${css}
    </head>
    <body>
      ${html}
    </body>
    </html>
  `;

  const blob = new Blob(['\ufeff', documentHtml], { type: 'application/msword' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${filename}.doc`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

interface AppDocument {
  id: string;
  file: File;
  base64: string;
  description: string;
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const [activeTab, setActiveTab] = useState<Tab>('gerar');
  
  // --- State for Gerar Escritura ---
  const [step, setStep] = useState<Step>('upload');
  const [documents, setDocuments] = useState<AppDocument[]>([]);
  
  const [selectedMinutaId, setSelectedMinutaId] = useState<number | ''>('');
  
  const [extractedPeople, setExtractedPeople] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [additionalDetails, setAdditionalDetails] = useState<string>('');
  
  const [draft, setDraft] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [modelUsed, setModelUsed] = useState<string>('');

  const docsInputRef = useRef<HTMLInputElement>(null);

  // --- State for Minutas ---
  const [minutas, setMinutas] = useState<Minuta[]>([]);
  const [isEditingMinuta, setIsEditingMinuta] = useState(false);
  const [currentMinuta, setCurrentMinuta] = useState<Partial<Minuta>>({ name: '', description: '', content: '', ai_instructions: '' });
  const [minutaSearchTerm, setMinutaSearchTerm] = useState('');
  const [isExtractingText, setIsExtractingText] = useState(false);
  const [viewingMinuta, setViewingMinuta] = useState<Minuta | null>(null);

  // --- State for Admin ---
  const [usersList, setUsersList] = useState<any[]>([]);
  const [newUser, setNewUser] = useState({ username: '', password: '', role: 'comum' });
  const [aiInstructions, setAiInstructions] = useState('');
  const [googleClientId, setGoogleClientId] = useState('');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [geminiApiKey, setGeminiApiKey] = useState('');
  const [historyList, setHistoryList] = useState<HistoryItem[]>([]);
  const [viewingHistory, setViewingHistory] = useState<HistoryItem | null>(null);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<number[]>([]);
  
  // --- State for Roles ---
  const [dbRoles, setDbRoles] = useState<{id: number, name: string}[]>([]);
  const [isEditingRole, setIsEditingRole] = useState(false);
  const [currentRole, setCurrentRole] = useState<{id?: number, name: string}>({ name: '' });

  const draftRef = useRef<HTMLDivElement>(null);
  const historyDraftRef = useRef<HTMLDivElement>(null);

  const [isChangingPassword, setIsChangingPassword] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  useEffect(() => {
    checkAuth();
  }, []);

  useEffect(() => {
    if (user) {
      fetchMinutas();
      fetchRoles();
      if (activeTab === 'historico') fetchHistory();
      if (user.role === 'administrador') {
        if (activeTab === 'usuarios') fetchUsers();
        if (activeTab === 'configuracoes') fetchSettings();
      }
    }
  }, [user, activeTab]);

  const fetchRoles = async () => {
    try {
      const res = await fetch('/api/roles');
      if (res.ok) {
        const data = await res.json();
        setDbRoles(data);
      }
    } catch (err) {
      console.error('Erro ao buscar papéis:', err);
    }
  };

  const handleSaveRole = async () => {
    try {
      if (!currentRole.name) {
        alert('Nome do papel é obrigatório.');
        return;
      }

      const method = currentRole.id ? 'PUT' : 'POST';
      const url = currentRole.id ? `/api/roles/${currentRole.id}` : '/api/roles';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentRole),
      });

      if (res.ok) {
        await fetchRoles();
        setIsEditingRole(false);
        setCurrentRole({ name: '' });
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao salvar papel.');
      }
    } catch (err) {
      console.error('Erro ao salvar papel:', err);
      alert('Erro ao salvar papel.');
    }
  };

  const handleDeleteRole = async (id: number) => {
    if (!confirm('Tem certeza que deseja deletar este papel?')) return;
    try {
      const res = await fetch(`/api/roles/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchRoles();
      }
    } catch (err) {
      console.error('Erro ao deletar papel:', err);
    }
  };

  const checkAuth = async () => {
    try {
      const res = await fetch('/api/me');
      if (res.ok) {
        const data = await res.json();
        setUser(data);
      }
    } catch (err) {
      console.error('Not authenticated');
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });
      if (res.ok) {
        const data = await res.json();
        setUser(data);
        setActiveTab('gerar');
      } else {
        const data = await res.json();
        setLoginError(data.error || 'Erro ao fazer login');
      }
    } catch (err) {
      setLoginError('Erro de conexão');
    }
  };

  const handleLogout = async () => {
    await fetch('/api/logout', { method: 'POST' });
    setUser(null);
  };

  const fetchUsers = async () => {
    const res = await fetch('/api/users');
    if (res.ok) setUsersList(await res.json());
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newUser),
    });
    if (res.ok) {
      setNewUser({ username: '', password: '', role: 'comum' });
      fetchUsers();
    } else {
      const data = await res.json();
      alert(data.error);
    }
  };

  const handleDeleteUser = async (id: number) => {
    if (confirm('Tem certeza que deseja excluir este usuário?')) {
      await fetch(`/api/users/${id}`, { method: 'DELETE' });
      fetchUsers();
    }
  };

  const fetchSettings = async () => {
    const res = await fetch('/api/settings/ai_instructions');
    if (res.ok) {
      const data = await res.json();
      setAiInstructions(data.instructions);
    }
    const resGoogle = await fetch('/api/settings/google');
    if (resGoogle.ok) {
      const dataGoogle = await resGoogle.json();
      setGoogleClientId(dataGoogle.clientId);
      setGoogleClientSecret(dataGoogle.clientSecret);
    }
    const resGemini = await fetch('/api/settings/gemini');
    if (resGemini.ok) {
      const dataGemini = await resGemini.json();
      setGeminiApiKey(dataGemini.apiKey);
    }
  };

  const handleSaveSettings = async () => {
    const res = await fetch('/api/settings/ai_instructions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instructions: aiInstructions }),
    });
    if (res.ok) alert('Instruções salvas com sucesso!');
  };

  const handleSaveGoogleSettings = async () => {
    const res = await fetch('/api/settings/google', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: googleClientId, clientSecret: googleClientSecret }),
    });
    if (res.ok) alert('Configurações do Google salvas com sucesso!');
  };

  const handleSaveGeminiSettings = async () => {
    const res = await fetch('/api/settings/gemini', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: geminiApiKey }),
    });
    if (res.ok) alert('Chave do Gemini salvas com sucesso!');
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');
    
    if (newPassword !== confirmNewPassword) {
      setPasswordError('As novas senhas não coincidem.');
      return;
    }
    
    try {
      const res = await fetch('/api/users/password', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      
      if (res.ok) {
        setPasswordSuccess('Senha alterada com sucesso!');
        setTimeout(() => {
          setIsChangingPassword(false);
          setCurrentPassword('');
          setNewPassword('');
          setConfirmNewPassword('');
          setPasswordSuccess('');
        }, 2000);
      } else {
        const data = await res.json();
        setPasswordError(data.error || 'Erro ao alterar senha.');
      }
    } catch (err) {
      setPasswordError('Erro de conexão.');
    }
  };

  const fetchHistory = async () => {
    const res = await fetch('/api/history');
    if (res.ok) setHistoryList(await res.json());
  };

  const handleDeleteHistory = async (idsToDelete?: number[]) => {
    const targetIds = idsToDelete || selectedHistoryIds;
    if (targetIds.length === 0) return;
    
    if (confirm(`Tem certeza que deseja excluir ${targetIds.length} item(ns) do histórico?`)) {
      try {
        const res = await fetch('/api/history', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: targetIds })
        });
        
        if (res.ok) {
          setSelectedHistoryIds(prev => prev.filter(id => !targetIds.includes(id)));
          fetchHistory();
        } else {
          alert('Erro ao excluir histórico.');
        }
      } catch (err) {
        console.error('Erro ao excluir histórico:', err);
        alert('Erro ao excluir histórico.');
      }
    }
  };

  const toggleHistorySelection = (id: number) => {
    setSelectedHistoryIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  const toggleAllHistorySelection = () => {
    if (selectedHistoryIds.length === historyList.length) {
      setSelectedHistoryIds([]);
    } else {
      setSelectedHistoryIds(historyList.map(item => item.id));
    }
  };

  const fetchMinutas = async () => {
    try {
      const res = await fetch('/api/minutas');
      if (res.ok) {
        const data = await res.json();
        setMinutas(data);
      }
    } catch (err) {
      console.error('Erro ao buscar minutas:', err);
    }
  };

  const handleSaveMinuta = async () => {
    try {
      if (!currentMinuta.name || !currentMinuta.content) {
        alert('Nome e conteúdo são obrigatórios.');
        return;
      }

      const method = currentMinuta.id ? 'PUT' : 'POST';
      const url = currentMinuta.id ? `/api/minutas/${currentMinuta.id}` : '/api/minutas';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(currentMinuta),
      });

      if (res.ok) {
        await fetchMinutas();
        setIsEditingMinuta(false);
        setCurrentMinuta({ name: '', description: '', content: '', ai_instructions: '' });
      } else {
        const data = await res.json();
        alert(data.error || 'Erro ao salvar minuta.');
      }
    } catch (err) {
      console.error('Erro ao salvar minuta:', err);
      alert('Erro ao salvar minuta.');
    }
  };

  const handleDeleteMinuta = async (id: number) => {
    if (!confirm('Tem certeza que deseja deletar esta minuta?')) return;
    try {
      const res = await fetch(`/api/minutas/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchMinutas();
        if (selectedMinutaId === id) setSelectedMinutaId('');
      }
    } catch (err) {
      console.error('Erro ao deletar minuta:', err);
    }
  };

  const handleDocsUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    const newDocs: AppDocument[] = [];
    
    for (const file of files) {
      if (file.type === 'application/pdf') {
        if (file.size > 45 * 1024 * 1024) {
          setError(`O arquivo ${file.name} é muito grande (limite de 45MB).`);
          continue;
        }
        try {
          const base64 = await fileToBase64(file);
          newDocs.push({
            id: Math.random().toString(36).substring(7),
            file,
            base64,
            description: ''
          });
        } catch (err) {
          setError(`Erro ao processar o arquivo ${file.name}.`);
        }
      } else {
        setError(`O arquivo ${file.name} não é um PDF válido.`);
      }
    }

    if (newDocs.length > 0) {
      setDocuments(prev => [...prev, ...newDocs]);
      setError('');
    }
    
    if (docsInputRef.current) docsInputRef.current.value = '';
  };

  const removeDocument = (id: string) => {
    setDocuments(prev => prev.filter(doc => doc.id !== id));
  };

  const updateDocumentDescription = (id: string, description: string) => {
    setDocuments(prev => prev.map(doc => doc.id === id ? { ...doc, description } : doc));
  };

  const handleExtractPeople = async () => {
    if (documents.length === 0) {
      setError('Por favor, envie os documentos das partes.');
      return;
    }
    if (!selectedMinutaId) {
      setError('Por favor, selecione uma minuta.');
      return;
    }
    
    const totalSize = documents.reduce((acc, doc) => acc + doc.base64.length, 0);
    if (totalSize > 50 * 1024 * 1024) {
      setError(`O tamanho total dos documentos excede o limite suportado (50MB). Por favor, comprima os arquivos PDF. Tamanho atual: ${(totalSize / 1024 / 1024).toFixed(1)}MB.`);
      return;
    }

    setError('');
    setStep('extracting');
    
    try {
      const docsInput = documents.map(doc => ({
        name: doc.file.name,
        description: doc.description,
        base64: doc.base64
      }));
      const people = await extractPeopleFromDocuments(docsInput);
      setExtractedPeople(people);
      
      const initialRoles: Record<string, string> = {};
      people.forEach(person => {
        initialRoles[person] = dbRoles.length > 0 ? dbRoles[0].name : '';
      });
      setRoles(initialRoles);
      
      setStep('roles');
    } catch (err) {
      console.error(err);
      setError((err as Error).message || 'Ocorreu um erro ao extrair os dados. Tente novamente.');
      setStep('upload');
    }
  };

  const handleRoleChange = (person: string, role: string) => {
    setRoles(prev => ({ ...prev, [person]: role }));
  };

  const handleGenerateDraft = async () => {
    setError('');
    setStep('generating');
    setModelUsed('');
    
    try {
      let minutaContent = '';
      let minutaName = '';
      let templateInstructions = '';

      if (selectedMinutaId) {
        const selectedMinuta = minutas.find(m => m.id === selectedMinutaId);
        if (!selectedMinuta) {
          throw new Error('Minuta selecionada não encontrada.');
        }
        minutaContent = selectedMinuta.content;
        minutaName = selectedMinuta.name;
        templateInstructions = selectedMinuta.ai_instructions || '';
        setModelUsed(selectedMinuta.name);
      } else {
        setModelUsed('Padrão do Sistema');
      }

      const activeRoles = Object.fromEntries(
        Object.entries(roles).filter(([_, role]) => role !== 'Não Participa (Ignorar)')
      );

      let customInstructions = '';
      try {
        const res = await fetch('/api/settings/ai_instructions');
        if (res.ok) {
          const data = await res.json();
          customInstructions = data.instructions;
        }
      } catch (e) {
        console.error("Failed to fetch custom instructions");
      }

      const docsInput = documents.map(doc => ({
        name: doc.file.name,
        description: doc.description,
        base64: doc.base64
      }));

      const generatedDraft = await generateDeedDraft(
        docsInput,
        minutaName || 'Escritura Pública',
        activeRoles,
        minutaContent,
        additionalDetails,
        customInstructions,
        templateInstructions
      );
      
      setDraft(generatedDraft);
      setStep('result');

      try {
        await fetch('/api/history', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            minuta_id: selectedMinutaId || null,
            minuta_name: minutaName || 'Padrão do Sistema',
            content: generatedDraft
          }),
        });
      } catch (e) {
        console.error("Failed to save history");
      }

    } catch (err) {
      console.error(err);
      setError((err as Error).message || 'Ocorreu um erro ao gerar a minuta. Tente novamente.');
      setStep('roles');
    }
  };

  const handleCopy = async () => {
    if (draftRef.current) {
      const success = await copyRichTextToClipboard(draftRef.current, draft);
      if (success) {
        alert('Minuta copiada com formatação para a área de transferência!');
      } else {
        navigator.clipboard.writeText(draft);
        alert('Minuta copiada (texto simples)!');
      }
    } else {
      navigator.clipboard.writeText(draft);
      alert('Minuta copiada (texto simples)!');
    }
  };

  const handleCopyHistory = async () => {
    if (historyDraftRef.current && viewingHistory) {
      const success = await copyRichTextToClipboard(historyDraftRef.current, viewingHistory.content);
      if (success) {
        alert('Minuta copiada com formatação para a área de transferência!');
      } else {
        navigator.clipboard.writeText(viewingHistory.content);
        alert('Minuta copiada (texto simples)!');
      }
    } else if (viewingHistory) {
      navigator.clipboard.writeText(viewingHistory.content);
      alert('Minuta copiada (texto simples)!');
    }
  };

  const handleDownload = () => {
    if (draftRef.current) {
      downloadAsWord(draftRef.current, 'Minuta');
    }
  };

  const handleDownloadHistory = () => {
    if (historyDraftRef.current && viewingHistory) {
      downloadAsWord(historyDraftRef.current, `Minuta_${viewingHistory.id}`);
    }
  };

  const handleReset = () => {
    setStep('upload');
    setDocuments([]);
    setExtractedPeople([]);
    setRoles({});
    setDraft('');
    setError('');
    setModelUsed('');
  };

  if (!user) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200 w-full max-w-md">
          <div className="flex flex-col items-center mb-8">
            <div className="bg-indigo-600 p-3 rounded-xl mb-4">
              <FileSignature className="w-8 h-8 text-white" />
            </div>
            <h1 className="text-2xl font-bold text-slate-800">Cartório AI</h1>
            <p className="text-slate-500 mt-2">Faça login para continuar</p>
          </div>
          
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Usuário</label>
              <input
                type="text"
                value={loginUsername}
                onChange={(e) => setLoginUsername(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                required
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">Senha</label>
              <input
                type="password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500 outline-none transition-all"
                required
              />
            </div>
            {loginError && <p className="text-red-500 text-sm text-center">{loginError}</p>}
            <button
              type="submit"
              className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-2.5 rounded-lg transition-colors"
            >
              Entrar
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-indigo-600 p-2 rounded-lg">
              <FileSignature className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold text-slate-800 tracking-tight">Cartório AI</h1>
          </div>
          <div className="flex items-center gap-2 overflow-x-auto no-scrollbar">
            <button 
              onClick={() => setActiveTab('gerar')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'gerar' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              Gerar Escritura
            </button>
            <button 
              onClick={() => setActiveTab('minutas')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'minutas' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              Minutas
            </button>
            <button 
              onClick={() => setActiveTab('historico')}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'historico' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
            >
              Histórico
            </button>
            
            {user.role === 'administrador' && (
              <>
                <button 
                  onClick={() => setActiveTab('usuarios')}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'usuarios' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  Usuários
                </button>
                <button 
                  onClick={() => setActiveTab('papeis')}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'papeis' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  Papéis
                </button>
                <button 
                  onClick={() => setActiveTab('configuracoes')}
                  className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors whitespace-nowrap ${activeTab === 'configuracoes' ? 'bg-indigo-50 text-indigo-700' : 'text-slate-600 hover:bg-slate-100'}`}
                >
                  Configurações
                </button>
              </>
            )}
            
            <div className="w-px h-6 bg-slate-200 mx-2"></div>
            
            <div className="flex items-center gap-3 ml-2">
              <span className="text-sm font-medium text-slate-700">Olá, {user.username}</span>
              <button 
                onClick={() => setIsChangingPassword(true)}
                className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                title="Alterar Senha"
              >
                <Key className="w-5 h-5" />
              </button>
              <button 
                onClick={handleLogout}
                className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                title="Sair"
              >
                <LogOut className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {activeTab === 'minutas' && (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Minutas Cadastradas</h2>
                <p className="text-slate-500 text-sm mt-1">Gerencie os modelos de escrituras do seu cartório.</p>
              </div>
              {!isEditingMinuta && user.role === 'administrador' && (
                <button
                  onClick={() => {
                    setCurrentMinuta({ name: '', description: '', content: '', ai_instructions: '' });
                    setIsEditingMinuta(true);
                  }}
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                >
                  <Plus className="w-4 h-4" />
                  Nova Minuta
                </button>
              )}
            </div>

            {isEditingMinuta ? (
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
                <div className="flex justify-between items-center mb-4">
                  <h3 className="text-lg font-semibold">{currentMinuta.id ? 'Editar Minuta' : 'Nova Minuta'}</h3>
                  <button onClick={() => setIsEditingMinuta(false)} className="text-slate-400 hover:text-slate-600">
                    <X className="w-5 h-5" />
                  </button>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Nome da Minuta *</label>
                  <input 
                    type="text" 
                    value={currentMinuta.name}
                    onChange={(e) => setCurrentMinuta({...currentMinuta, name: e.target.value})}
                    placeholder="Ex: Compra e Venda Padrão"
                    className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Descrição</label>
                  <input 
                    type="text" 
                    value={currentMinuta.description}
                    onChange={(e) => setCurrentMinuta({...currentMinuta, description: e.target.value})}
                    placeholder="Breve descrição sobre quando usar esta minuta"
                    className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Conteúdo da Minuta *</label>
                  <div className="mb-2 flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => document.getElementById('minuta-pdf-upload')?.click()}
                      className="text-sm bg-slate-100 hover:bg-slate-200 text-slate-700 py-1.5 px-3 rounded-lg flex items-center gap-2 transition-colors"
                      disabled={isExtractingText}
                    >
                      {isExtractingText ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                      {isExtractingText ? 'Extraindo texto...' : 'Extrair de PDF'}
                    </button>
                    <input
                      id="minuta-pdf-upload"
                      type="file"
                      accept="application/pdf"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        try {
                          setIsExtractingText(true);
                          const base64 = await fileToBase64(file);
                          const text = await extractTextFromPdf(base64);
                          setCurrentMinuta(prev => ({ ...prev, content: text }));
                        } catch (err) {
                          alert('Erro ao extrair texto do PDF.');
                        } finally {
                          setIsExtractingText(false);
                          e.target.value = '';
                        }
                      }}
                    />
                    <span className="text-xs text-slate-500">Ou cole o texto diretamente abaixo</span>
                  </div>
                  <div className="bg-white rounded-xl border border-slate-300 overflow-hidden focus-within:ring-2 focus-within:ring-indigo-600 focus-within:border-indigo-600">
                    <ReactQuill 
                      theme="snow"
                      value={currentMinuta.content}
                      onChange={(content) => setCurrentMinuta({...currentMinuta, content})}
                      placeholder="Cole aqui o texto completo do modelo da minuta..."
                      className="min-h-[300px]"
                      modules={{
                        toolbar: [
                          [{ 'header': [1, 2, 3, false] }],
                          ['bold', 'italic', 'underline', 'strike'],
                          [{ 'color': [] }, { 'background': [] }],
                          [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                          [{ 'align': [] }],
                          ['clean']
                        ]
                      }}
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">Instruções Específicas para a IA (Opcional)</label>
                  <p className="text-xs text-slate-500 mb-2">Adicione instruções que a IA deve seguir especificamente ao gerar esta minuta.</p>
                  <textarea 
                    value={currentMinuta.ai_instructions || ''}
                    onChange={(e) => setCurrentMinuta({...currentMinuta, ai_instructions: e.target.value})}
                    placeholder="Ex: Certifique-se de incluir a cláusula de incomunicabilidade. Sempre use o termo 'Outorgante' em vez de 'Vendedor'."
                    className="w-full p-4 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none min-h-[100px] resize-y text-sm"
                  />
                </div>

                <div className="flex justify-end gap-3 pt-4">
                  <button
                    onClick={() => setIsEditingMinuta(false)}
                    className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg font-medium transition-colors"
                  >
                    Cancelar
                  </button>
                  <button
                    onClick={handleSaveMinuta}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    <Save className="w-4 h-4" />
                    Salvar Minuta
                  </button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {minutas.length === 0 ? (
                  <div className="col-span-full p-8 text-center bg-white border border-slate-200 rounded-2xl text-slate-500">
                    <Database className="w-12 h-12 mx-auto text-slate-300 mb-3" />
                    <p>Nenhuma minuta cadastrada.</p>
                    <p className="text-sm mt-1">Clique em "Nova Minuta" para adicionar o primeiro modelo.</p>
                  </div>
                ) : (
                  minutas.map(minuta => (
                    <div key={minuta.id} className="bg-white p-5 rounded-2xl shadow-sm border border-slate-200 flex flex-col">
                      <div className="flex justify-between items-start mb-2">
                        <h3 className="font-semibold text-slate-800">{minuta.name}</h3>
                        {user.role === 'administrador' && (
                          <div className="flex gap-1">
                            <button 
                              onClick={() => {
                                setCurrentMinuta(minuta);
                                setIsEditingMinuta(true);
                              }}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                              title="Editar"
                            >
                              <Edit2 className="w-4 h-4" />
                            </button>
                            <button 
                              onClick={() => handleDeleteMinuta(minuta.id)}
                              className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-md transition-colors"
                              title="Excluir"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                      </div>
                      <p className="text-sm text-slate-500 mb-4 flex-1">{minuta.description || 'Sem descrição'}</p>
                      <div className="text-xs text-slate-400">
                        Cadastrada em: {new Date(minuta.created_at).toLocaleDateString()}
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === 'gerar' && (
          <>
            <div className="mb-12">
              <div className="flex items-center justify-between relative">
                <div className="absolute left-0 top-1/2 -translate-y-1/2 w-full h-0.5 bg-slate-200 -z-10"></div>
                
                {[
                  { id: 'upload', icon: Upload, label: 'Documentos' },
                  { id: 'roles', icon: Users, label: 'Partes' },
                  { id: 'result', icon: FileText, label: 'Minuta' }
                ].map((s, i) => {
                  const isActive = step === s.id || 
                    (s.id === 'upload' && step === 'extracting') ||
                    (s.id === 'roles' && step === 'generating');
                    
                  const isPast = 
                    (s.id === 'upload' && ['roles', 'generating', 'result'].includes(step)) ||
                    (s.id === 'roles' && step === 'result');

                  return (
                    <div key={s.id} className="flex flex-col items-center gap-2 bg-slate-50 px-2">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center border-2 transition-colors ${
                        isActive ? 'border-indigo-600 bg-indigo-50 text-indigo-600' : 
                        isPast ? 'border-emerald-500 bg-emerald-500 text-white' : 
                        'border-slate-300 bg-white text-slate-400'
                      }`}>
                        {isPast ? <CheckCircle className="w-5 h-5" /> : <s.icon className="w-5 h-5" />}
                      </div>
                      <span className={`text-xs font-medium ${isActive || isPast ? 'text-slate-900' : 'text-slate-400'}`}>
                        {s.label}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>

            {error && (
              <div className="mb-8 p-4 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm flex items-start gap-3">
                <div className="mt-0.5 font-bold">!</div>
                <p>{error}</p>
              </div>
            )}

            {step === 'upload' && (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
                  <h2 className="text-lg font-semibold mb-2">1. Selecione a Minuta</h2>
                  <p className="text-slate-500 text-sm mb-4">
                    Busque pelo nome ou descrição da minuta (digite pelo menos 3 caracteres).
                  </p>
                  
                  <div className="mb-4 relative">
                    <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                      <Search className="h-5 w-5 text-slate-400" />
                    </div>
                    <input
                      type="text"
                      placeholder="Buscar minuta..."
                      value={minutaSearchTerm}
                      onChange={(e) => setMinutaSearchTerm(e.target.value)}
                      className="w-full pl-10 p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                    />
                  </div>

                  {selectedMinutaId && (
                    <div className="mb-4 p-4 bg-indigo-50 border border-indigo-200 rounded-xl flex justify-between items-center">
                      <div>
                        <span className="text-xs font-semibold text-indigo-800 uppercase tracking-wider">Minuta Selecionada</span>
                        <p className="font-medium text-indigo-900 mt-1">{minutas.find(m => m.id === selectedMinutaId)?.name}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => setViewingMinuta(minutas.find(m => m.id === selectedMinutaId) || null)} 
                          className="text-indigo-600 hover:text-indigo-800 text-sm font-medium flex items-center gap-1"
                        >
                          <Eye className="w-4 h-4" /> Visualizar
                        </button>
                        <button onClick={() => setSelectedMinutaId('')} className="text-indigo-600 hover:text-indigo-800 text-sm font-medium">
                          Trocar
                        </button>
                      </div>
                    </div>
                  )}

                  {!selectedMinutaId && minutaSearchTerm.length >= 3 && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {minutas
                        .filter(m => m.name.toLowerCase().includes(minutaSearchTerm.toLowerCase()) || (m.description && m.description.toLowerCase().includes(minutaSearchTerm.toLowerCase())))
                        .map(minuta => (
                          <label 
                            key={minuta.id} 
                            className={`flex flex-col p-4 border rounded-xl cursor-pointer transition-colors ${
                              selectedMinutaId === minuta.id ? 'border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600' : 'border-slate-200 hover:border-indigo-300'
                            }`}
                          >
                            <div className="flex items-center justify-between mb-2">
                              <div className="flex items-center">
                                <input 
                                  type="radio" 
                                  name="minutaSelection" 
                                  value={minuta.id} 
                                  checked={selectedMinutaId === minuta.id}
                                  onChange={() => setSelectedMinutaId(minuta.id)}
                                  className="text-indigo-600 focus:ring-indigo-600"
                                />
                                <span className="ml-3 font-semibold text-slate-800">{minuta.name}</span>
                              </div>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.preventDefault();
                                  setViewingMinuta(minuta);
                                }}
                                className="text-slate-400 hover:text-indigo-600 p-1 rounded-md transition-colors"
                                title="Visualizar Minuta"
                              >
                                <Eye className="w-4 h-4" />
                              </button>
                            </div>
                            <span className="text-xs text-slate-500 ml-7">{minuta.description || 'Sem descrição'}</span>
                          </label>
                        ))}
                      {minutas.filter(m => m.name.toLowerCase().includes(minutaSearchTerm.toLowerCase()) || (m.description && m.description.toLowerCase().includes(minutaSearchTerm.toLowerCase()))).length === 0 && (
                        <div className="col-span-full text-center text-slate-500 py-4">
                          Nenhuma minuta encontrada para "{minutaSearchTerm}".
                        </div>
                      )}
                    </div>
                  )}
                  
                  {!selectedMinutaId && minutaSearchTerm.length > 0 && minutaSearchTerm.length < 3 && (
                    <div className="text-sm text-slate-500 text-center py-4">
                      Digite mais {3 - minutaSearchTerm.length} caractere(s) para buscar...
                    </div>
                  )}
                  
                  {!selectedMinutaId && minutas.length === 0 && (
                    <div className="p-4 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-sm flex items-center justify-between mt-4">
                      <span>Nenhuma minuta cadastrada.</span>
                      <button onClick={() => setActiveTab('minutas')} className="underline font-medium">Cadastrar agora</button>
                    </div>
                  )}
                </div>

                <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
                  <h2 className="text-lg font-semibold mb-2">2. Documentos das Partes e Imóvel</h2>
                  <p className="text-slate-500 text-sm mb-6">
                    Envie os arquivos PDF contendo os RGs, CPFs, certidões de casamento/nascimento e matrículas/certidões do imóvel. Você pode enviar um único arquivo com tudo ou vários arquivos separados.
                  </p>
                  
                  <div 
                    onClick={() => docsInputRef.current?.click()}
                    className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
                      documents.length > 0 ? 'border-indigo-500 bg-indigo-50' : 'border-slate-300 hover:border-indigo-400 hover:bg-slate-50'
                    }`}
                  >
                    <input 
                      type="file" 
                      ref={docsInputRef} 
                      onChange={handleDocsUpload} 
                      accept="application/pdf" 
                      multiple
                      className="hidden" 
                    />
                    <div className="mx-auto w-12 h-12 bg-white rounded-full shadow-sm flex items-center justify-center mb-4">
                      <Upload className={`w-6 h-6 ${documents.length > 0 ? 'text-indigo-600' : 'text-slate-400'}`} />
                    </div>
                    <div>
                      <p className="font-medium text-slate-700">Clique para selecionar os PDFs</p>
                      <p className="text-xs text-slate-500 mt-1">Você pode selecionar múltiplos arquivos .pdf</p>
                    </div>
                  </div>

                  {documents.length > 0 && (
                    <div className="mt-6 space-y-3">
                      <h3 className="text-sm font-medium text-slate-700">Arquivos Selecionados:</h3>
                      {documents.map((doc) => (
                        <div key={doc.id} className="flex items-center gap-4 bg-slate-50 p-3 rounded-lg border border-slate-200">
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-slate-900 truncate" title={doc.file.name}>{doc.file.name}</p>
                            <p className="text-xs text-slate-500">{(doc.file.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                          <div className="flex-1">
                            <input
                              type="text"
                              placeholder="O que tem neste arquivo? (Ex: Vendedores, Imóvel)"
                              value={doc.description}
                              onChange={(e) => updateDocumentDescription(doc.id, e.target.value)}
                              className="w-full text-sm border-slate-300 rounded-md shadow-sm focus:border-indigo-500 focus:ring-indigo-500"
                            />
                          </div>
                          <button
                            onClick={() => removeDocument(doc.id)}
                            className="p-2 text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                            title="Remover arquivo"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="flex justify-end">
                  <button
                    onClick={handleExtractPeople}
                    disabled={documents.length === 0 || !selectedMinutaId}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    Avançar para Identificação
                    <ArrowRight className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

            {(step === 'extracting' || step === 'generating') && (
              <div className="bg-white p-12 rounded-2xl shadow-sm border border-slate-200 text-center animate-in fade-in duration-500">
                <RefreshCw className="w-12 h-12 text-indigo-600 animate-spin mx-auto mb-6" />
                <h2 className="text-xl font-semibold mb-2">
                  {step === 'extracting' ? 'Analisando Documentos...' : 'Redigindo Minuta...'}
                </h2>
                <p className="text-slate-500">
                  {step === 'extracting' 
                    ? 'A inteligência artificial está lendo os PDFs e extraindo as partes envolvidas.' 
                    : 'A IA está elaborando a escritura com base nos documentos e no modelo selecionado. Isso pode levar alguns segundos.'}
                </p>
              </div>
            )}

            {step === 'roles' && (
              <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
                  <h2 className="text-lg font-semibold mb-2">Identificação das Partes</h2>
                  <p className="text-slate-500 text-sm mb-6">
                    A IA identificou as seguintes pessoas nos documentos. Defina o papel de cada uma na escritura.
                  </p>
                  
                  {extractedPeople.length === 0 ? (
                    <div className="p-6 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-center">
                      Nenhuma pessoa foi identificada automaticamente. O documento pode estar ilegível.
                    </div>
                  ) : (
                    <div className="space-y-4">
                      {extractedPeople.map((person, index) => (
                        <div key={index} className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 bg-slate-50 border border-slate-200 rounded-xl">
                          <div className="flex-1">
                            <span className="font-semibold text-slate-800">{person}</span>
                          </div>
                          <div className="w-full sm:w-64">
                            <select 
                              value={roles[person] || ''} 
                              onChange={(e) => handleRoleChange(person, e.target.value)}
                              className="w-full p-2.5 bg-white border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                            >
                              {dbRoles.map(role => (
                                <option key={role.id} value={role.name}>{role.name}</option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
                  <h2 className="text-lg font-semibold mb-2">Detalhes Adicionais (Opcional)</h2>
                  <p className="text-slate-500 text-sm mb-6">
                    Insira informações convenientes para a lavratura da escritura (ex: forma de pagamento, usufruto, cláusulas de incomunicabilidade ou inalienabilidade).
                  </p>
                  <textarea
                    value={additionalDetails}
                    onChange={(e) => setAdditionalDetails(e.target.value)}
                    placeholder="Ex: O pagamento será feito à vista via PIX. Incluir cláusula de usufruto vitalício para a vendedora..."
                    className="w-full p-4 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none min-h-[120px] resize-y"
                  />
                </div>

                <div className="flex justify-between">
                  <button
                    onClick={() => setStep('upload')}
                    className="text-slate-600 hover:text-slate-900 px-6 py-3 font-medium transition-colors"
                  >
                    Voltar
                  </button>
                  <button
                    onClick={handleGenerateDraft}
                    disabled={extractedPeople.length === 0}
                    className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white px-6 py-3 rounded-xl font-medium flex items-center gap-2 transition-colors shadow-sm"
                  >
                    Gerar Minuta
                    <FileSignature className="w-5 h-5" />
                  </button>
                </div>
              </div>
            )}

            {step === 'result' && (
              <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                {modelUsed && (
                  <div className="bg-emerald-50 border border-emerald-200 p-4 rounded-xl flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-emerald-600 mt-0.5" />
                    <div>
                      <h3 className="text-sm font-semibold text-emerald-800">Modelo Utilizado</h3>
                      <p className="text-sm text-emerald-700 mt-1">
                        A IA utilizou a minuta <strong>{modelUsed}</strong> como base.
                      </p>
                    </div>
                  </div>
                )}
                
                <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col h-[800px]">
                  <div className="bg-slate-50 border-b border-slate-200 p-4 flex items-center justify-between">
                    <h2 className="font-semibold text-slate-800 flex items-center gap-2">
                      <FileText className="w-5 h-5 text-indigo-600" />
                      Minuta Gerada
                    </h2>
                    <div className="flex gap-2">
                      <button 
                        onClick={handleCopy}
                        className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Copy className="w-4 h-4" />
                        Copiar
                      </button>
                      <button 
                        onClick={handleDownload}
                        className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                      >
                        <Download className="w-4 h-4" />
                        Download Word
                      </button>
                    </div>
                  </div>
                  
                  <div className="flex-1 overflow-y-auto overflow-x-hidden p-8 bg-white" ref={draftRef}>
                    <div className="prose prose-slate max-w-none prose-headings:font-serif prose-p:leading-relaxed">
                      <Markdown rehypePlugins={[rehypeRaw]}>{draft}</Markdown>
                    </div>
                  </div>
                </div>

                <div className="flex justify-center">
                  <button
                    onClick={handleReset}
                    className="text-indigo-600 hover:text-indigo-800 font-medium flex items-center gap-2 transition-colors"
                  >
                    <RefreshCw className="w-4 h-4" />
                    Nova Escritura
                  </button>
                </div>
              </div>
            )}
          </>
        )}

        {activeTab === 'usuarios' && user.role === 'administrador' && (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Usuários</h2>
                <p className="text-slate-500 text-sm mt-1">Gerencie os usuários do sistema.</p>
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
              <h3 className="text-lg font-semibold">Novo Usuário</h3>
              <form onSubmit={handleCreateUser} className="flex flex-col sm:flex-row gap-4">
                <input
                  type="text"
                  placeholder="Nome de usuário"
                  value={newUser.username}
                  onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                  className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  required
                />
                <input
                  type="password"
                  placeholder="Senha"
                  value={newUser.password}
                  onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                  className="flex-1 px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  required
                />
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value as any })}
                  className="px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                >
                  <option value="comum">Comum</option>
                  <option value="administrador">Administrador</option>
                </select>
                <button type="submit" className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium transition-colors">
                  Criar
                </button>
              </form>
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="p-4 font-semibold text-slate-600 text-sm">Usuário</th>
                    <th className="p-4 font-semibold text-slate-600 text-sm">Papel</th>
                    <th className="p-4 font-semibold text-slate-600 text-sm">Criado em</th>
                    <th className="p-4 font-semibold text-slate-600 text-sm w-24 text-center">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {usersList.map(u => (
                    <tr key={u.id} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                      <td className="p-4 font-medium text-slate-800">{u.username}</td>
                      <td className="p-4 text-slate-600 capitalize">{u.role}</td>
                      <td className="p-4 text-slate-500 text-sm">{new Date(u.created_at).toLocaleString('pt-BR')}</td>
                      <td className="p-4 text-center">
                        <button onClick={() => handleDeleteUser(u.id)} className="text-slate-400 hover:text-red-600 p-2 rounded-lg transition-colors" title="Excluir">
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {usersList.length === 0 && (
                    <tr>
                      <td colSpan={4} className="p-8 text-center text-slate-500">Nenhum usuário encontrado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'papeis' && user.role === 'administrador' && (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Gerenciamento de Papéis</h2>
                <p className="text-slate-500">Adicione, edite ou remova papéis para as minutas.</p>
              </div>
              <button
                onClick={() => {
                  setCurrentRole({ name: '' });
                  setIsEditingRole(true);
                }}
                className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
              >
                <Plus className="w-5 h-5" />
                Novo Papel
              </button>
            </div>

            {isEditingRole && currentRole && (
              <div className="bg-white p-6 rounded-xl shadow-sm border border-slate-200">
                <h3 className="text-lg font-semibold mb-4">{currentRole.id ? 'Editar Papel' : 'Novo Papel'}</h3>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1">Nome do Papel</label>
                    <input
                      type="text"
                      value={currentRole.name}
                      onChange={(e) => setCurrentRole({ ...currentRole, name: e.target.value })}
                      className="w-full p-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                      placeholder="Ex: Vendedor(a)"
                    />
                  </div>
                  <div className="flex justify-end gap-3">
                    <button
                      onClick={() => {
                        setIsEditingRole(false);
                        setCurrentRole(null);
                      }}
                      className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={handleSaveRole}
                      className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors"
                    >
                      <Save className="w-5 h-5" />
                      Salvar
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="p-4 font-semibold text-slate-700">Nome</th>
                    <th className="p-4 font-semibold text-slate-700 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {dbRoles.map((role) => (
                    <tr key={role.id} className="hover:bg-slate-50 transition-colors">
                      <td className="p-4 text-slate-800">{role.name}</td>
                      <td className="p-4 text-right space-x-2">
                        <button
                          onClick={() => {
                            setCurrentRole(role);
                            setIsEditingRole(true);
                          }}
                          className="p-2 text-slate-500 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                          title="Editar"
                        >
                          <Edit className="w-5 h-5" />
                        </button>
                        <button
                          onClick={() => handleDeleteRole(role.id!)}
                          className="p-2 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                          title="Excluir"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {dbRoles.length === 0 && (
                    <tr>
                      <td colSpan={2} className="p-8 text-center text-slate-500">Nenhum papel encontrado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {activeTab === 'configuracoes' && user.role === 'administrador' && (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Instruções da IA</h2>
                <p className="text-slate-500 text-sm mt-1">Personalize o prompt base utilizado pela Inteligência Artificial.</p>
              </div>
              <button onClick={handleSaveSettings} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm">
                <Save className="w-4 h-4" />
                Salvar
              </button>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <textarea
                value={aiInstructions}
                onChange={(e) => setAiInstructions(e.target.value)}
                className="w-full h-[400px] p-4 font-mono text-sm border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-500 outline-none resize-y"
              />
              <p className="text-xs text-slate-500 mt-4">
                <strong>Variáveis disponíveis:</strong> {'{{deedType}}'}, {'{{rolesText}}'}, {'{{additionalDetailsText}}'}
                <br /><br />
                <strong>Formatação Rica:</strong> Você pode usar tags HTML diretamente no texto ou nos modelos (ex: <code>&lt;b&gt;negrito&lt;/b&gt;</code>, <code>&lt;i&gt;itálico&lt;/i&gt;</code>, <code>&lt;span style="color: red"&gt;texto vermelho&lt;/span&gt;</code>) para que a IA gere a minuta com essa formatação.
              </p>
            </div>

            <div className="flex justify-between items-center pt-6 border-t border-slate-200">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Integração Google Drive</h2>
                <p className="text-slate-500 text-sm mt-1">Configure as credenciais da API do Google.</p>
              </div>
              <button onClick={handleSaveGoogleSettings} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm">
                <Save className="w-4 h-4" />
                Salvar
              </button>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Google Client ID</label>
                <input 
                  type="text" 
                  value={googleClientId}
                  onChange={(e) => setGoogleClientId(e.target.value)}
                  placeholder="Ex: 123456789-abcde.apps.googleusercontent.com"
                  className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Google Client Secret</label>
                <input 
                  type="password" 
                  value={googleClientSecret}
                  onChange={(e) => setGoogleClientSecret(e.target.value)}
                  placeholder="Ex: GOCSPX-abcdef..."
                  className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                />
              </div>
            </div>

            <div className="flex justify-between items-center pt-6 border-t border-slate-200">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Integração Gemini AI</h2>
                <p className="text-slate-500 text-sm mt-1">Configure a chave de API do Google Gemini.</p>
              </div>
              <button onClick={handleSaveGeminiSettings} className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors shadow-sm">
                <Save className="w-4 h-4" />
                Salvar
              </button>
            </div>
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Gemini API Key</label>
                <input 
                  type="password" 
                  value={geminiApiKey}
                  onChange={(e) => setGeminiApiKey(e.target.value)}
                  placeholder="Ex: AIzaSy..."
                  className="w-full p-3 border border-slate-300 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:border-indigo-600 outline-none"
                />
              </div>
            </div>
          </div>
        )}

        {activeTab === 'historico' && (
          <div className="space-y-6 animate-in fade-in duration-500">
            <div className="flex justify-between items-center">
              <div>
                <h2 className="text-2xl font-bold text-slate-800">Histórico de Minutas</h2>
                <p className="text-slate-500 text-sm mt-1">
                  {user.role === 'administrador' ? 'Visualize todas as minutas geradas no sistema.' : 'Visualize suas minutas geradas.'}
                </p>
              </div>
              {selectedHistoryIds.length > 0 && (
                <button
                  onClick={() => handleDeleteHistory()}
                  className="bg-red-50 text-red-600 hover:bg-red-100 px-4 py-2 rounded-xl font-medium flex items-center gap-2 transition-colors border border-red-200"
                >
                  <Trash2 className="w-4 h-4" />
                  Excluir Selecionados ({selectedHistoryIds.length})
                </button>
              )}
            </div>

            <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-slate-50 border-b border-slate-200">
                    <th className="p-4 w-12 text-center">
                      <input 
                        type="checkbox" 
                        checked={historyList.length > 0 && selectedHistoryIds.length === historyList.length}
                        onChange={toggleAllHistorySelection}
                        className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                      />
                    </th>
                    {user.role === 'administrador' && <th className="p-4 font-semibold text-slate-600 text-sm">Usuário</th>}
                    <th className="p-4 font-semibold text-slate-600 text-sm">Modelo Utilizado</th>
                    <th className="p-4 font-semibold text-slate-600 text-sm">Data</th>
                    <th className="p-4 font-semibold text-slate-600 text-sm w-24 text-center">Ações</th>
                  </tr>
                </thead>
                <tbody>
                  {historyList.map(h => (
                    <tr key={h.id} className={`border-b border-slate-100 last:border-0 hover:bg-slate-50 ${selectedHistoryIds.includes(h.id) ? 'bg-indigo-50/50' : ''}`}>
                      <td className="p-4 text-center">
                        <input 
                          type="checkbox" 
                          checked={selectedHistoryIds.includes(h.id)}
                          onChange={() => toggleHistorySelection(h.id)}
                          className="w-4 h-4 text-indigo-600 rounded border-slate-300 focus:ring-indigo-500"
                        />
                      </td>
                      {user.role === 'administrador' && <td className="p-4 font-medium text-slate-800">{h.username}</td>}
                      <td className="p-4 text-slate-600">{h.minuta_name}</td>
                      <td className="p-4 text-slate-500 text-sm">{new Date(h.created_at).toLocaleString('pt-BR')}</td>
                      <td className="p-4 text-center">
                        <div className="flex items-center justify-center gap-2">
                          <button onClick={() => setViewingHistory(h)} className="text-slate-400 hover:text-indigo-600 p-2 rounded-lg transition-colors" title="Visualizar">
                            <Eye className="w-5 h-5" />
                          </button>
                          <button 
                            onClick={() => handleDeleteHistory([h.id])} 
                            className="text-slate-400 hover:text-red-600 p-2 rounded-lg transition-colors" 
                            title="Excluir"
                          >
                            <Trash2 className="w-5 h-5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {historyList.length === 0 && (
                    <tr>
                      <td colSpan={user.role === 'administrador' ? 5 : 4} className="p-8 text-center text-slate-500">Nenhum histórico encontrado.</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

      </main>

      {viewingMinuta && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[90vh] flex flex-col shadow-xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center p-6 border-b border-slate-200">
              <h3 className="text-xl font-semibold text-slate-800">{viewingMinuta.name}</h3>
              <button onClick={() => setViewingMinuta(null)} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            <div className="p-6 overflow-y-auto overflow-x-hidden flex-1 bg-slate-50">
              <div className="prose prose-slate max-w-none prose-headings:font-serif prose-p:leading-relaxed bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
                <Markdown rehypePlugins={[rehypeRaw]}>{viewingMinuta.content}</Markdown>
              </div>
            </div>
          </div>
        </div>
      )}

      {viewingHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-start p-6 border-b border-slate-200">
              <div className="flex-1 pr-4">
                <h3 className="text-xl font-semibold text-slate-800">Histórico: {viewingHistory.minuta_name}</h3>
                <p className="text-sm text-slate-500 mt-1">
                  Gerado por {viewingHistory.username} em {new Date(viewingHistory.created_at).toLocaleString('pt-BR')}
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <button 
                  onClick={handleCopyHistory}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Copy className="w-4 h-4" />
                  Copiar
                </button>
                <button 
                  onClick={handleDownloadHistory}
                  className="flex items-center gap-2 px-3 py-1.5 bg-white border border-slate-300 rounded-lg text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  Download Word
                </button>
                <button onClick={() => setViewingHistory(null)} className="text-slate-400 hover:text-slate-600 transition-colors ml-2">
                  <X className="w-6 h-6" />
                </button>
              </div>
            </div>
            <div className="p-6 overflow-y-auto overflow-x-hidden flex-1 bg-slate-50">
              <div className="prose prose-slate max-w-none prose-headings:font-serif prose-p:leading-relaxed bg-white p-8 rounded-xl border border-slate-200 shadow-sm" ref={historyDraftRef}>
                <Markdown rehypePlugins={[rehypeRaw]}>{viewingHistory.content}</Markdown>
              </div>
            </div>
          </div>
        </div>
      )}

      {isChangingPassword && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md flex flex-col shadow-xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center p-6 border-b border-slate-200">
              <h3 className="text-xl font-semibold text-slate-800">Alterar Senha</h3>
              <button onClick={() => {
                setIsChangingPassword(false);
                setPasswordError('');
                setPasswordSuccess('');
                setCurrentPassword('');
                setNewPassword('');
                setConfirmNewPassword('');
              }} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-6 h-6" />
              </button>
            </div>
            <form onSubmit={handleChangePassword} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Senha Atual</label>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Nova Senha</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">Confirmar Nova Senha</label>
                <input
                  type="password"
                  value={confirmNewPassword}
                  onChange={(e) => setConfirmNewPassword(e.target.value)}
                  className="w-full px-4 py-2 border border-slate-300 rounded-lg focus:ring-2 focus:ring-indigo-500 outline-none"
                  required
                />
              </div>
              {passwordError && <p className="text-red-500 text-sm">{passwordError}</p>}
              {passwordSuccess && <p className="text-emerald-600 text-sm font-medium">{passwordSuccess}</p>}
              <div className="pt-4 flex justify-end gap-3">
                <button
                  type="button"
                  onClick={() => setIsChangingPassword(false)}
                  className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-lg font-medium transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-700 text-white px-6 py-2 rounded-lg font-medium transition-colors"
                >
                  Salvar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
