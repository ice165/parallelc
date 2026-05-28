import fs from 'fs';
import path from 'path';
import { StaticAnalyzer } from './static-analyzer.js';
import { GitDiffFallback } from './git-diff-fallback.js';

export interface PredictionResult {
  files: string[];
  source: 'LLM' | 'STATIC_ANALYZER' | 'GIT_DIFF' | 'FULL_SRC';
  confidence: number;
}

export class FilePredictor {
  private staticAnalyzer = new StaticAnalyzer();
  private gitFallback = new GitDiffFallback();

  predict(llmFiles: string[], taskTitle: string, repoRoot: string): PredictionResult {
    // Layer 1: LLM prediction
    const llmValid = this.validatePrediction(llmFiles, repoRoot);
    if (llmValid.valid && llmFiles.length > 0) {
      return { files: llmFiles, source: 'LLM', confidence: 0.8 };
    }

    // Layer 2: Static analysis
    const staticFiles = this.staticAnalyzer.analyze(
      llmFiles.length > 0 ? llmFiles : [taskTitle],
      repoRoot,
    );
    if (staticFiles.length > 0 && staticFiles.length <= 50) {
      return { files: staticFiles, source: 'STATIC_ANALYZER', confidence: 0.6 };
    }

    // Layer 3: git diff fallback
    const gitFiles = this.gitFallback.getFallback(repoRoot);
    if (gitFiles.length > 0) {
      return { files: gitFiles, source: 'GIT_DIFF', confidence: 0.4 };
    }

    return { files: [], source: 'FULL_SRC', confidence: 0.2 };
  }

  validatePrediction(files: string[], repoRoot: string): { valid: boolean; reason?: string } {
    if (files.length === 0) return { valid: true };
    if (files.length > 50) return { valid: false, reason: `Too many files: ${files.length} > 50` };

    for (const f of files) {
      if (f.includes('..')) return { valid: false, reason: `Path traversal detected: ${f}` };
      const fullPath = path.join(repoRoot, f);
      if (!fs.existsSync(fullPath)) {
        const parentDir = path.dirname(fullPath);
        if (!fs.existsSync(parentDir)) {
          return { valid: false, reason: `Parent directory does not exist: ${f}` };
        }
      }
    }

    return { valid: true };
  }
}
