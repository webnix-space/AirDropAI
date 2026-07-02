import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet, Text, View, TextInput, TouchableOpacity,
  ScrollView, ActivityIndicator, Alert, Platform, SafeAreaView,
  StatusBar, Animated, Dimensions, Share
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Device from 'expo-device';

// ═══════════════════════════════════════════════════════════════
// WEBNIX AI — Production Build
// Fixed modelType: "llamacpp-completion" + result.final API
// + chat save, mic placeholder, tok/s
// ═══════════════════════════════════════════════════════════════

let QVAC_AVAILABLE = true;
let loadModel, completion, unloadModel, ragSaveEmbeddings, ragSearch,
    LLAMA_3_2_1B_INST_Q4_0, GTE_LARGE_FP16;

try {
  const sdk = require('@qvac/sdk');
  loadModel         = sdk.loadModel;
  completion        = sdk.completion;
  unloadModel       = sdk.unloadModel;
  ragSaveEmbeddings = sdk.ragSaveEmbeddings;
  ragSearch         = sdk.ragSearch;
  LLAMA_3_2_1B_INST_Q4_0 = sdk.LLAMA_3_2_1B_INST_Q4_0;
  GTE_LARGE_FP16    = sdk.GTE_LARGE_FP16;
  // Log all exports so we can see exact names if something breaks
  console.log('[QVAC] exports:', Object.keys(sdk).join(', '));
} catch (e) {
  console.error('QVAC SDK load failed:', e);
  QVAC_AVAILABLE = false;
}

const { width } = Dimensions.get('window');
const TABS = { FILES: 'files', NOTES: 'notes', ASK: 'ask' };

const chunkText = (text, size = 400, overlap = 80) => {
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + size));
    i += size - overlap;
  }
  return chunks;
};

const extractTextFromFile = async (uri, mimeType, name) => {
  try {
    if (
      mimeType === 'text/plain' ||
      name.endsWith('.txt') || name.endsWith('.md') ||
      name.endsWith('.csv') || name.endsWith('.json')
    ) {
      return await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.UTF8 });
    }
    const raw = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return `File: ${name}\nType: ${mimeType}\nSize: ${raw.length} bytes\nNote: Binary file.`;
  } catch (e) {
    throw new Error(`Could not read file: ${e.message}`);
  }
};

export default function App() {
  const [llmModelId,   setLlmModelId]   = useState(null);
  const [embedModelId, setEmbedModelId] = useState(null);
  const [loadingState, setLoadingState] = useState('idle');
  const [loadProgress, setLoadProgress] = useState(0);
  const [loadStatus,   setLoadStatus]   = useState('');

  const [activeTab,    setActiveTab]    = useState(TABS.ASK);
  const [logs,         setLogs]         = useState([]);

  // Files
  const [indexedFiles, setIndexedFiles] = useState([]);
  const [isIndexing,   setIsIndexing]   = useState(false);
  const [currentFile,  setCurrentFile]  = useState(null);

  // Notes
  const [noteText,     setNoteText]     = useState('');
  const [noteTitle,    setNoteTitle]    = useState('');
  const [savedNotes,   setSavedNotes]   = useState([]);
  const [isSavingNote, setIsSavingNote] = useState(false);

  // Ask
  const [query,        setQuery]        = useState('');
  const [chatHistory,  setChatHistory]  = useState([]);
  const [isAnswering,  setIsAnswering]  = useState(false);
  const [tps,          setTps]          = useState(null);

  const scrollRef  = useRef(null);
  const inputRef   = useRef(null);

  const log = useCallback((msg) => {
    setLogs(prev => [...prev.slice(-30), `${new Date().toLocaleTimeString()} ${msg}`]);
  }, []);

  useEffect(() => {
    if (!QVAC_AVAILABLE) {
      setLoadingState('error');
      setLoadStatus('QVAC SDK unavailable');
      return;
    }
    bootModels();
    return () => {
      if (llmModelId)   unloadModel({ modelId: llmModelId }).catch(() => {});
      if (embedModelId) unloadModel({ modelId: embedModelId }).catch(() => {});
    };
  }, []);

  // Auto-scroll chat
  useEffect(() => {
    if (chatHistory.length > 0) {
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 100);
    }
  }, [chatHistory]);

  const bootModels = async () => {
    setLoadingState('loading');
    try {
      // ── LLM: correct modelType for llama.cpp LLM ──────────────
      setLoadStatus('Loading language model...');
      log('Loading Llama 3.2 1B...');
      const llmId = await loadModel({
        modelSrc:  LLAMA_3_2_1B_INST_Q4_0,
        modelType: 'llamacpp-completion',          // ← FIXED
        onProgress: p => setLoadProgress(Math.round(p * 55)),
      });
      setLlmModelId(llmId);
      log('LLM ready: ' + llmId.slice(0, 8));

      // ── Embedder ───────────────────────────────────────────────
      setLoadStatus('Loading embedding model...');
      log('Loading GTE-Large...');
      const embedId = await loadModel({
        modelSrc:  GTE_LARGE_FP16,
        modelType: 'embeddings',
        onProgress: p => setLoadProgress(55 + Math.round(p * 45)),
      });
      setEmbedModelId(embedId);
      log('Embedder ready');

      setLoadingState('ready');
      setLoadProgress(100);
      setLoadStatus('');
      log('All models active');
    } catch (err) {
      log(`Boot failed: ${err.message}`);
      setLoadingState('error');
      setLoadStatus(err.message);
    }
  };

  // ── File indexing ──────────────────────────────────────────────
  const pickAndIndexFile = async () => {
    if (!embedModelId) return Alert.alert('Not Ready', 'Models loading.');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['text/*', 'application/pdf', 'application/json', '*/*'],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;

      const file = result.assets[0];
      setCurrentFile(file.name);
      setIsIndexing(true);
      log(`Indexing: ${file.name}`);

      const text = await extractTextFromFile(file.uri, file.mimeType, file.name);
      if (!text || text.length < 10) throw new Error('File empty or unreadable');

      const chunks = chunkText(text);
      await ragSaveEmbeddings({ modelId: embedModelId, documents: chunks, chunk: false });

      setIndexedFiles(prev => [...prev, {
        name: file.name, chunks: chunks.length,
        indexedAt: new Date().toLocaleTimeString(),
      }]);
      log(`✓ Indexed: ${file.name} (${chunks.length} chunks)`);
      Alert.alert('Done', `"${file.name}" ready to query.`);
    } catch (err) {
      log(`Index failed: ${err.message}`);
      Alert.alert('Error', err.message);
    } finally {
      setIsIndexing(false);
      setCurrentFile(null);
    }
  };

  // ── Save note ──────────────────────────────────────────────────
  const saveNote = async () => {
    if (!noteText.trim()) return Alert.alert('Empty', 'Write something first.');
    if (!embedModelId)    return Alert.alert('Not Ready', 'Models loading.');

    setIsSavingNote(true);
    const title = noteTitle.trim() || `Note ${savedNotes.length + 1}`;
    try {
      const chunks = chunkText(`Title: ${title}\n\n${noteText.trim()}`);
      await ragSaveEmbeddings({ modelId: embedModelId, documents: chunks, chunk: false });
      setSavedNotes(prev => [...prev, { title, preview: noteText.slice(0, 80), savedAt: new Date().toLocaleTimeString() }]);
      log(`✓ Note saved: ${title}`);
      setNoteText(''); setNoteTitle('');
      Alert.alert('Saved', `"${title}" ready to query.`);
    } catch (err) {
      log(`Save failed: ${err.message}`);
      Alert.alert('Error', err.message);
    } finally {
      setIsSavingNote(false);
    }
  };

  // ── Ask AI ─────────────────────────────────────────────────────
  const askAI = async () => {
    const q = query.trim();
    if (!q) return;
    if (!llmModelId) return Alert.alert('Not Ready', 'Models loading.');

    const userMsg = { role: 'user', content: q, ts: new Date().toLocaleTimeString() };
    setChatHistory(prev => [...prev, userMsg]);
    setQuery('');
    setTps(null);
    setIsAnswering(true);
    log(`Query: ${q}`);

    // Streaming answer placeholder
    const assistantMsg = { role: 'assistant', content: '', ts: new Date().toLocaleTimeString(), streaming: true };
    setChatHistory(prev => [...prev, assistantMsg]);

    try {
      // RAG
      let context = '';
      let source  = 'general knowledge';
      if (embedModelId && (indexedFiles.length > 0 || savedNotes.length > 0)) {
        try {
          const results = await ragSearch({ modelId: embedModelId, query: q, topK: 4 });
          if (results?.length && results[0].score > 0.5) {
            context = results.map((r, i) => `[${i+1}] ${r.content || r.text}`).join('\n\n');
            source  = 'your files & notes';
            log(`RAG: ${results.length} matches`);
          }
        } catch { log('RAG skipped'); }
      }

      const systemPrompt = context
        ? `You are Webnix AI, private assistant on this device. Use context below. Be concise.\n\nContext:\n${context}`
        : `You are Webnix AI, private assistant running entirely on this device. Be concise.`;

      const history = [
        { role: 'system', content: systemPrompt },
        ...chatHistory.filter(m => !m.streaming).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: q },
      ];

      // Use result.events API (current SDK)
      const run = completion({ modelId: llmModelId, history, stream: true });

      let accumulated = '';
      let tokenCount  = 0;
      const startTime = Date.now();

      for await (const event of run.events) {
        if (event.type === 'contentDelta') {
          accumulated += event.text;
          tokenCount++;
          setChatHistory(prev => {
            const next = [...prev];
            next[next.length - 1] = { ...next[next.length - 1], content: accumulated };
            return next;
          });
          const elapsed = (Date.now() - startTime) / 1000;
          if (elapsed > 0.3) setTps((tokenCount / elapsed).toFixed(1));
        }
        if (event.type === 'completionStats' && event.stats?.tokensPerSecond) {
          setTps(event.stats.tokensPerSecond.toFixed(1));
        }
      }

      // Mark done
      setChatHistory(prev => {
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], streaming: false, source };
        return next;
      });

      const elapsed = (Date.now() - startTime) / 1000;
      log(`Done — ${tokenCount} tok, ${elapsed > 0 ? (tokenCount/elapsed).toFixed(1) : '?'} tok/s`);
    } catch (err) {
      log(`Query failed: ${err.message}`);
      setChatHistory(prev => {
        const next = [...prev];
        next[next.length - 1] = { ...next[next.length - 1], content: 'Error: ' + err.message, streaming: false };
        return next;
      });
    } finally {
      setIsAnswering(false);
    }
  };

  // ── Save / share chat ──────────────────────────────────────────
  const saveChat = async () => {
    if (chatHistory.length === 0) return Alert.alert('Empty', 'No conversation yet.');
    const text = chatHistory
      .map(m => `[${m.ts}] ${m.role === 'user' ? 'You' : 'Webnix AI'}: ${m.content}`)
      .join('\n\n');
    const filename = `${FileSystem.documentDirectory}webnix-chat-${Date.now()}.txt`;
    try {
      await FileSystem.writeAsStringAsync(filename, text, { encoding: FileSystem.EncodingType.UTF8 });
      await Share.share({ message: text, title: 'Webnix AI Chat' });
      await AsyncStorage.setItem('chat_history', JSON.stringify(updatedHistory));
      log('Chat saved & shared');
    } catch (err) {
      // Fallback: just share the text
      try { await Share.share({ message: text, title: 'Webnix AI Chat' }); }
      catch { Alert.alert('Error', err.message); }
    }
  };

  const clearChat = () => {
    setChatHistory([]);
    setTps(null);
    log('Chat cleared');
  };

  // ── Boot screen ────────────────────────────────────────────────
  if (loadingState === 'loading' || loadingState === 'idle') {
    return (
      <View style={styles.bootScreen}>
        <StatusBar barStyle="light-content" backgroundColor="#080808" />
        <View style={styles.bootLogo}>
          <Text style={styles.bootIcon}>◈</Text>
          <Text style={styles.bootTitle}>Webnix AI</Text>
          <Text style={styles.bootSub}>Private Intelligence. On Device.</Text>
        </View>
        <View style={styles.bootProgress}>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${loadProgress}%` }]} />
          </View>
          <Text style={styles.bootStatusText}>{loadStatus}</Text>
        </View>
        <Text style={styles.bootDevice}>{Device.modelName || 'Device'} · Local Silicon</Text>
      </View>
    );
  }

  if (loadingState === 'error') {
    return (
      <View style={styles.bootScreen}>
        <Text style={styles.errorIcon}>✕</Text>
        <Text style={styles.errorTitle}>Failed to Start</Text>
        <Text style={styles.errorMsg}>{loadStatus}</Text>
        <TouchableOpacity style={styles.retryBtn} onPress={bootModels}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Main UI ────────────────────────────────────────────────────
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#080808" />

      {/* Header */}
      <View style={styles.header}>
        <View>
          <Text style={styles.headerTitle}>◈ Webnix AI</Text>
          <Text style={styles.headerSub}>All processing on this device</Text>
        </View>
        <View style={styles.headerBadge}>
          <View style={styles.onlineDot} />
          <Text style={styles.onlineText}>Online</Text>
        </View>
      </View>

      {/* Tabs */}
      <View style={styles.tabBar}>
        {[
          { key: TABS.ASK,   label: 'Ask AI' },
          { key: TABS.FILES, label: 'Files' },
          { key: TABS.NOTES, label: 'Notes' },
        ].map(tab => (
          <TouchableOpacity
            key={tab.key}
            style={[styles.tab, activeTab === tab.key && styles.tabActive]}
            onPress={() => setActiveTab(tab.key)}
          >
            <Text style={[styles.tabText, activeTab === tab.key && styles.tabTextActive]}>
              {tab.label}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* ── ASK TAB ── */}
      {activeTab === TABS.ASK && (
        <View style={{ flex: 1 }}>
          {/* Chat messages */}
          <ScrollView
            ref={scrollRef}
            style={styles.chatScroll}
            contentContainerStyle={styles.chatInner}
            keyboardShouldPersistTaps="handled"
          >
            {chatHistory.length === 0 && (
              <View style={styles.emptyChat}>
                <Text style={styles.emptyChatIcon}>◈</Text>
                <Text style={styles.emptyChatTitle}>Webnix AI</Text>
                <Text style={styles.emptyChatSub}>
                  {indexedFiles.length === 0 && savedNotes.length === 0
                    ? 'Ask anything. No files indexed yet — using general knowledge.'
                    : `${indexedFiles.length} file(s) + ${savedNotes.length} note(s) indexed.`}
                </Text>
              </View>
            )}

            {chatHistory.map((msg, i) => (
              <View key={i} style={[
                styles.bubble,
                msg.role === 'user' ? styles.bubbleUser : styles.bubbleAI,
              ]}>
                {msg.role === 'assistant' && (
                  <Text style={styles.bubbleLabel}>
                    Webnix AI{msg.source ? ` · ${msg.source}` : ''}{msg.streaming ? ' ▌' : ''}
                  </Text>
                )}
                <Text style={[styles.bubbleText, msg.role === 'user' && styles.bubbleTextUser]}>
                  {msg.content || (msg.streaming ? '...' : '')}
                </Text>
                <Text style={styles.bubbleTs}>{msg.ts}</Text>
              </View>
            ))}

            {/* tok/s badge */}
            {tps && !isAnswering && (
              <View style={styles.tpsBadge}>
                <Text style={styles.tpsText}>{tps} tok/s</Text>
              </View>
            )}
          </ScrollView>

          {/* Action bar */}
          {chatHistory.length > 0 && (
            <View style={styles.chatActions}>
              <TouchableOpacity style={styles.chatActionBtn} onPress={saveChat}>
                <Text style={styles.chatActionText}>↓ Save Chat</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.chatActionBtn} onPress={clearChat}>
                <Text style={styles.chatActionText}>✕ Clear</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Input row */}
          <View style={styles.inputRow}>
            <TextInput
              ref={inputRef}
              style={styles.chatInput}
              placeholder="Ask Webnix AI..."
              placeholderTextColor="#444"
              value={query}
              onChangeText={setQuery}
              multiline
              maxHeight={100}
              onSubmitEditing={askAI}
              blurOnSubmit={false}
            />
            <TouchableOpacity
              style={[styles.sendBtn, isAnswering && styles.btnDisabled]}
              onPress={askAI}
              disabled={isAnswering}
            >
              {isAnswering
                ? <ActivityIndicator size="small" color="#080808" />
                : <Text style={styles.sendBtnText}>↑</Text>
              }
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* ── FILES TAB ── */}
      {activeTab === TABS.FILES && (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
          <TouchableOpacity
            style={[styles.primaryBtn, isIndexing && styles.btnDisabled]}
            onPress={pickAndIndexFile}
            disabled={isIndexing}
          >
            {isIndexing ? (
              <View style={styles.btnRow}>
                <ActivityIndicator size="small" color="#080808" />
                <Text style={[styles.primaryBtnText, { marginLeft: 8 }]}>
                  Indexing {currentFile ? `"${currentFile.slice(0, 20)}..."` : '...'}
                </Text>
              </View>
            ) : (
              <Text style={styles.primaryBtnText}>+ Pick File to Index</Text>
            )}
          </TouchableOpacity>

          <Text style={styles.sectionHint}>TXT, MD, CSV, JSON, PDF. Stays on device.</Text>

          {indexedFiles.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>▣</Text>
              <Text style={styles.emptyTitle}>No files indexed</Text>
              <Text style={styles.emptyDesc}>Pick a file to make it queryable with AI.</Text>
            </View>
          ) : indexedFiles.map((f, i) => (
            <View key={i} style={styles.fileCard}>
              <View style={styles.fileCardLeft}>
                <Text style={styles.fileCardIcon}>◻</Text>
                <View>
                  <Text style={styles.fileCardName} numberOfLines={1}>{f.name}</Text>
                  <Text style={styles.fileCardMeta}>{f.chunks} chunks · {f.indexedAt}</Text>
                </View>
              </View>
              <View style={styles.fileCardBadge}>
                <Text style={styles.fileCardBadgeText}>Indexed</Text>
              </View>
            </View>
          ))}
        </ScrollView>
      )}

      {/* ── NOTES TAB ── */}
      {activeTab === TABS.NOTES && (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentInner} keyboardShouldPersistTaps="handled">
          <TextInput
            style={styles.noteTitleInput}
            placeholder="Note title (optional)"
            placeholderTextColor="#444"
            value={noteTitle}
            onChangeText={setNoteTitle}
          />
          <TextInput
            style={styles.noteBodyInput}
            placeholder="Write your note — thoughts, research, meeting notes. AI will index and search it."
            placeholderTextColor="#444"
            value={noteText}
            onChangeText={setNoteText}
            multiline
            textAlignVertical="top"
          />
          <TouchableOpacity
            style={[styles.primaryBtn, isSavingNote && styles.btnDisabled]}
            onPress={saveNote}
            disabled={isSavingNote}
          >
            {isSavingNote ? (
              <View style={styles.btnRow}>
                <ActivityIndicator size="small" color="#080808" />
                <Text style={[styles.primaryBtnText, { marginLeft: 8 }]}>Saving...</Text>
              </View>
            ) : (
              <Text style={styles.primaryBtnText}>Save & Index Note</Text>
            )}
          </TouchableOpacity>

          {savedNotes.length === 0 ? (
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>◎</Text>
              <Text style={styles.emptyTitle}>No notes yet</Text>
              <Text style={styles.emptyDesc}>Save a note to make it searchable.</Text>
            </View>
          ) : savedNotes.map((n, i) => (
            <View key={i} style={styles.fileCard}>
              <View style={styles.fileCardLeft}>
                <Text style={styles.fileCardIcon}>◎</Text>
                <View style={{ flex: 1 }}>
                  <Text style={styles.fileCardName}>{n.title}</Text>
                  <Text style={styles.fileCardMeta} numberOfLines={2}>{n.preview}</Text>
                </View>
              </View>
            </View>
          ))}

          {/* Activity log */}
          {logs.length > 0 && (
            <View style={[styles.logCard, { marginTop: 20 }]}>
              <Text style={styles.logLabel}>Activity</Text>
              {logs.slice(-6).map((l, i) => (
                <Text key={i} style={styles.logLine}>{l}</Text>
              ))}
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// ── Styles ─────────────────────────────────────────────────────
const C = {
  bg: '#080808', surface: '#111111', border: '#1E1E1E',
  accent: '#00FFCC', accentDim: '#00FFCC18', text: '#F0F0F0',
  textMid: '#888', textDim: '#444', danger: '#FF4444',
  userBubble: '#00FFCC', userBubbleText: '#080808',
};

const styles = StyleSheet.create({
  // Boot
  bootScreen:     { flex: 1, backgroundColor: C.bg, alignItems: 'center', justifyContent: 'center', padding: 32 },
  bootLogo:       { alignItems: 'center', marginBottom: 48 },
  bootIcon:       { fontSize: 48, color: C.accent, marginBottom: 12 },
  bootTitle:      { fontSize: 28, fontWeight: '700', color: C.text, letterSpacing: 1 },
  bootSub:        { fontSize: 13, color: C.textMid, marginTop: 6, letterSpacing: 0.5 },
  bootProgress:   { width: '100%', alignItems: 'center', marginBottom: 24 },
  progressTrack:  { width: '100%', height: 2, backgroundColor: C.border, borderRadius: 2, marginBottom: 12, overflow: 'hidden' },
  progressFill:   { height: 2, backgroundColor: C.accent, borderRadius: 2 },
  bootStatusText: { fontSize: 12, color: C.textMid, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  bootDevice:     { fontSize: 11, color: C.textDim, position: 'absolute', bottom: 40 },
  errorIcon:      { fontSize: 40, color: C.danger, marginBottom: 12 },
  errorTitle:     { fontSize: 20, fontWeight: '700', color: C.text, marginBottom: 8 },
  errorMsg:       { fontSize: 13, color: C.textMid, textAlign: 'center', marginBottom: 24 },
  retryBtn:       { backgroundColor: C.accent, paddingHorizontal: 32, paddingVertical: 12, borderRadius: 8 },
  retryText:      { color: C.bg, fontWeight: '700', fontSize: 14 },

  // Layout
  root:           { flex: 1, backgroundColor: C.bg },
  header:         { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: C.border },
  headerTitle:    { fontSize: 17, fontWeight: '700', color: C.text, letterSpacing: 0.5 },
  headerSub:      { fontSize: 10, color: C.textMid, marginTop: 1 },
  headerBadge:    { flexDirection: 'row', alignItems: 'center', backgroundColor: '#00FFCC10', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 20, borderWidth: 1, borderColor: '#00FFCC30' },
  onlineDot:      { width: 6, height: 6, borderRadius: 3, backgroundColor: C.accent, marginRight: 6 },
  onlineText:     { fontSize: 11, color: C.accent, fontWeight: '600' },

  // Tabs
  tabBar:         { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: C.border },
  tab:            { flex: 1, paddingVertical: 12, alignItems: 'center' },
  tabActive:      { borderBottomWidth: 2, borderBottomColor: C.accent },
  tabText:        { fontSize: 13, color: C.textMid, fontWeight: '500' },
  tabTextActive:  { color: C.accent, fontWeight: '700' },

  // Chat
  chatScroll:     { flex: 1 },
  chatInner:      { padding: 16, paddingBottom: 8 },
  emptyChat:      { alignItems: 'center', paddingVertical: 60 },
  emptyChatIcon:  { fontSize: 40, color: C.textDim, marginBottom: 12 },
  emptyChatTitle: { fontSize: 18, fontWeight: '700', color: C.textMid, marginBottom: 6 },
  emptyChatSub:   { fontSize: 13, color: C.textDim, textAlign: 'center', lineHeight: 20, paddingHorizontal: 20 },

  bubble:         { marginBottom: 12, maxWidth: '85%' },
  bubbleUser:     { alignSelf: 'flex-end', backgroundColor: C.accent, borderRadius: 16, borderBottomRightRadius: 4, padding: 12 },
  bubbleAI:       { alignSelf: 'flex-start', backgroundColor: C.surface, borderRadius: 16, borderBottomLeftRadius: 4, padding: 12, borderWidth: 1, borderColor: C.border },
  bubbleLabel:    { fontSize: 10, color: C.accent, fontWeight: '700', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  bubbleText:     { fontSize: 14, color: C.text, lineHeight: 21 },
  bubbleTextUser: { color: C.bg },
  bubbleTs:       { fontSize: 9, color: 'rgba(255,255,255,0.3)', marginTop: 4, textAlign: 'right' },

  tpsBadge:       { alignSelf: 'center', backgroundColor: '#00FFCC15', borderWidth: 1, borderColor: '#00FFCC30', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 3, marginBottom: 8 },
  tpsText:        { fontSize: 11, color: C.accent, fontWeight: '700', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },

  chatActions:    { flexDirection: 'row', paddingHorizontal: 16, paddingVertical: 6, gap: 8 },
  chatActionBtn:  { flex: 1, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  chatActionText: { fontSize: 12, color: C.textMid, fontWeight: '600' },

  inputRow:       { flexDirection: 'row', padding: 12, paddingTop: 6, alignItems: 'flex-end', borderTopWidth: 1, borderTopColor: C.border, gap: 8 },
  chatInput:      { flex: 1, backgroundColor: C.surface, borderRadius: 20, borderWidth: 1, borderColor: C.border, color: C.text, paddingHorizontal: 16, paddingVertical: 10, fontSize: 14, maxHeight: 100 },
  sendBtn:        { backgroundColor: C.accent, width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  sendBtnText:    { fontSize: 18, color: C.bg, fontWeight: '700' },
  btnDisabled:    { opacity: 0.5 },
  btnRow:         { flexDirection: 'row', alignItems: 'center' },

  // Content (files/notes)
  content:        { flex: 1 },
  contentInner:   { padding: 16, paddingBottom: 40 },
  primaryBtn:     { backgroundColor: C.accent, paddingVertical: 14, borderRadius: 10, alignItems: 'center', marginBottom: 10 },
  primaryBtnText: { color: C.bg, fontWeight: '700', fontSize: 15 },
  sectionHint:    { fontSize: 12, color: C.textMid, marginBottom: 16, lineHeight: 18 },
  emptyState:     { alignItems: 'center', paddingVertical: 48 },
  emptyIcon:      { fontSize: 36, color: C.textDim, marginBottom: 12 },
  emptyTitle:     { fontSize: 15, fontWeight: '600', color: C.textMid, marginBottom: 6 },
  emptyDesc:      { fontSize: 13, color: C.textDim, textAlign: 'center', lineHeight: 20 },

  fileCard:       { backgroundColor: C.surface, borderRadius: 10, borderWidth: 1, borderColor: C.border, padding: 14, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  fileCardLeft:   { flexDirection: 'row', alignItems: 'center', flex: 1 },
  fileCardIcon:   { fontSize: 20, color: C.accent, marginRight: 12 },
  fileCardName:   { fontSize: 14, fontWeight: '600', color: C.text, maxWidth: width * 0.5 },
  fileCardMeta:   { fontSize: 11, color: C.textMid, marginTop: 2 },
  fileCardBadge:  { backgroundColor: C.accentDim, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  fileCardBadgeText: { fontSize: 11, color: C.accent, fontWeight: '600' },

  noteTitleInput: { backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, color: C.text, padding: 12, fontSize: 15, fontWeight: '600', marginBottom: 8 },
  noteBodyInput:  { backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, color: C.text, padding: 12, fontSize: 14, minHeight: 140, marginBottom: 12, lineHeight: 22 },

  logCard:        { backgroundColor: C.surface, borderRadius: 8, borderWidth: 1, borderColor: C.border, padding: 12 },
  logLabel:       { fontSize: 11, color: C.textMid, fontWeight: '600', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 },
  logLine:        { fontSize: 10, color: '#555', fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', marginBottom: 3, lineHeight: 15 },
});
