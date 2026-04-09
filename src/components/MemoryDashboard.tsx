import React, { useState, useEffect, useRef } from 'react';
import { 
  Card, 
  CardContent, 
  CardHeader, 
  CardTitle, 
  CardDescription 
} from "../../components/ui/card";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Badge } from "../../components/ui/badge";
import { 
  Brain, 
  History, 
  Network, 
  Database, 
  Send, 
  Zap, 
  Moon, 
  Trash2,
  RefreshCw,
  Info
} from "lucide-react";
import { MemoryService, Actor, EpisodicMemory, SemanticFact } from "../lib/memoryService";
import { toast } from "sonner";
import { motion, AnimatePresence } from "framer-motion";

export default function MemoryDashboard() {
  const [input, setInput] = useState("");
  const [sessionId] = useState(`session_${Date.now()}`);
  const [stm, setStm] = useState<EpisodicMemory[]>([]);
  const [ltm, setLtm] = useState<SemanticFact[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [stats, setStats] = useState({ stm: 0, mtm: 0, ltm: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    MemoryService.testConnection();
    loadStats();
    loadSTM();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [stm]);

  const loadStats = async () => {
    try {
      const s = await MemoryService.getStats();
      setStats(s);
    } catch {
      // stats unavailable — leave defaults
    }
  };

  const loadSTM = async () => {
    const logs = await MemoryService.getRecentContext(sessionId);
    if (logs) setStm(logs);
  };

  const handleSend = async () => {
    if (!input.trim() || isProcessing) return;

    const userText = input;
    setInput("");
    setIsProcessing(true);

    try {
      // 1. Add to STM
      await MemoryService.addEpisodicLog(sessionId, Actor.USER, userText);
      await loadSTM();

      // 2. Search LTM for context
      const context = await MemoryService.searchLTM(userText);
      if (context) setLtm(context);

      // 3. Simulate Agent Response (In a real app, call Gemini here)
      const agentResponse = `I've recorded your message in the Short-Term Memory. ${context && context.length > 0 ? `I also recalled some relevant long-term facts: "${context[0].distilledFact}"` : "I'm still building my long-term knowledge base."}`;
      
      const interactionId = await MemoryService.addEpisodicLog(sessionId, Actor.AGENT, agentResponse);
      await loadSTM();

      // 4. Consolidate to MTM (Asynchronous in theory, but here for demo)
      if (interactionId) {
        await MemoryService.consolidateToMTM(interactionId, userText);
      }

      toast.success("Memory encoded successfully");
    } catch (error) {
      toast.error("Failed to process memory");
    } finally {
      setIsProcessing(false);
      loadStats();
    }
  };

  const runSleepCycle = async () => {
    toast.info("Starting Sleep-Cycle Consolidation...");
    try {
      const result = await MemoryService.runSleepCycle();
      if (result) {
        toast.success(`Sleep-Cycle complete: Pruned ${result.pruned} nodes, Consolidated ${result.consolidated} facts.`);
      } else {
        toast.info("Not enough data for consolidation yet.");
      }
    } catch (error) {
      toast.error("Sleep-Cycle failed");
    }
  };

  return (
    <div className="min-h-screen p-4 md:p-8 flex flex-col gap-6 max-w-7xl mx-auto">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-ink pb-6">
        <div>
          <h1 className="text-4xl font-serif italic tracking-tight flex items-center gap-2">
            <Brain className="w-10 h-10" />
            NH-RAG Memory Engine
          </h1>
          <p className="text-sm font-mono opacity-60 mt-1 uppercase tracking-widest">
            Neuro-Hierarchical Retrieval-Augmented Generation
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={runSleepCycle} className="font-mono text-xs border-ink hover:bg-ink hover:text-bg">
            <Moon className="w-4 h-4 mr-2" />
            RUN SLEEP-CYCLE
          </Button>
          <Button variant="outline" size="sm" onClick={loadStats} className="font-mono text-xs border-ink hover:bg-ink hover:text-bg">
            <RefreshCw className="w-4 h-4 mr-2" />
            REFRESH
          </Button>
        </div>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1">
        {/* Left Column: Interaction & STM */}
        <Card className="lg:col-span-2 border-ink bg-transparent shadow-none rounded-none flex flex-col h-[600px]">
          <CardHeader className="border-b border-ink py-3">
            <div className="flex justify-between items-center">
              <CardTitle className="text-sm font-mono uppercase tracking-widest flex items-center gap-2">
                <History className="w-4 h-4" />
                Short-Term Memory (Episodic Buffer)
              </CardTitle>
              <Badge variant="outline" className="font-mono text-[10px] border-ink">VOLATILE</Badge>
            </div>
          </CardHeader>
          <CardContent className="flex-1 flex flex-col p-0 overflow-hidden">
            <ScrollArea className="flex-1 p-4" ref={scrollRef}>
              <div className="space-y-4">
                {stm.map((log, i) => (
                  <motion.div 
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className={`flex flex-col ${log.actor === Actor.USER ? 'items-end' : 'items-start'}`}
                  >
                    <div className={`max-w-[80%] p-3 border border-ink ${log.actor === Actor.USER ? 'bg-ink text-bg' : 'bg-white'}`}>
                      <p className="text-sm">{log.rawText}</p>
                      <div className="flex justify-between items-center mt-2 opacity-50 text-[10px] font-mono">
                        <span>{log.actor.toUpperCase()}</span>
                        <span>{new Date(log.timestamp).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  </motion.div>
                ))}
                {isProcessing && (
                  <div className="flex items-center gap-2 text-xs font-mono opacity-50">
                    <Zap className="w-3 h-3 animate-pulse" />
                    ENCODING...
                  </div>
                )}
              </div>
            </ScrollArea>
            <div className="p-4 border-t border-ink bg-white/50">
              <form 
                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                className="flex gap-2"
              >
                <Input 
                  placeholder="Enter episodic observation..." 
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  className="border-ink rounded-none focus-visible:ring-0"
                />
                <Button type="submit" className="bg-ink text-bg rounded-none hover:bg-ink/90">
                  <Send className="w-4 h-4" />
                </Button>
              </form>
            </div>
          </CardContent>
        </Card>

        {/* Right Column: MTM & LTM Stats */}
        <div className="space-y-6">
          <Card className="border-ink bg-transparent shadow-none rounded-none">
            <CardHeader className="border-b border-ink py-3">
              <CardTitle className="text-sm font-mono uppercase tracking-widest flex items-center gap-2">
                <Network className="w-4 h-4" />
                Medium-Term Memory (Graph)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <div className="space-y-4">
                <div className="flex justify-between items-center border-b border-ink/20 pb-2">
                  <span className="text-xs font-mono uppercase">Nodes</span>
                  <span className="font-mono font-bold">{stats.stm}</span>
                </div>
                <div className="flex justify-between items-center border-b border-ink/20 pb-2">
                  <span className="text-xs font-mono uppercase">Edges (Similarity)</span>
                  <span className="font-mono font-bold">--</span>
                </div>
                <div className="p-3 bg-white border border-ink/20 text-[10px] font-mono leading-relaxed">
                  <p className="opacity-60 italic">"MTM maps associative relationships using vector similarity edges. Nodes below the Salience Threshold are pruned during Sleep-Cycle."</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-ink bg-transparent shadow-none rounded-none flex-1">
            <CardHeader className="border-b border-ink py-3">
              <CardTitle className="text-sm font-mono uppercase tracking-widest flex items-center gap-2">
                <Database className="w-4 h-4" />
                Long-Term Memory (Neocortex)
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4">
              <ScrollArea className="h-[250px]">
                <div className="space-y-3">
                  {ltm.length === 0 ? (
                    <div className="text-center py-8 opacity-40">
                      <Info className="w-8 h-8 mx-auto mb-2" />
                      <p className="text-[10px] font-mono uppercase">No semantic facts distilled yet</p>
                    </div>
                  ) : (
                    ltm.map((fact, i) => (
                      <div key={i} className="p-2 border border-ink/20 bg-white text-xs">
                        <p className="font-medium">{fact.distilledFact}</p>
                        <div className="flex justify-between items-center mt-2 text-[8px] font-mono opacity-50">
                          <span>PROVENANCE: {fact.provenance?.length || 0} NODES</span>
                          <span>SCORE: {(fact as any).score?.toFixed(3)}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </ScrollArea>
            </CardContent>
          </Card>
        </div>
      </div>

      <footer className="mt-auto pt-6 border-t border-ink flex flex-col md:flex-row justify-between items-center gap-4 text-[10px] font-mono uppercase tracking-widest opacity-60">
        <div className="flex gap-4">
          <span>Status: Operational</span>
          <span>Region: US-CENTRAL1</span>
        </div>
        <div>
          © 2026 Biomimetic Architecture Lab
        </div>
      </footer>
    </div>
  );
}
