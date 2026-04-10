import "../env.js";

export interface ParsedSection {
  sectionLabel?: string;
  pageRange?: string;
  markdown: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface ParsedDocument {
  parserName: string;
  summary?: string;
  pageCount?: number;
  sections: ParsedSection[];
}

const DOCLING_SERVICE_URL = process.env.DOCLING_SERVICE_URL || "http://localhost:8081/parse";

export async function parseDocumentWithDocling(file: Express.Multer.File): Promise<ParsedDocument> {
  let doclingFailure: string | null = null;

  try {
    const form = new FormData();
    form.append(
      "file",
      new Blob([file.buffer], { type: file.mimetype || "application/octet-stream" }),
      file.originalname
    );

    const response = await fetch(DOCLING_SERVICE_URL, {
      method: "POST",
      body: form,
    });

    if (response.ok) {
      return (await response.json()) as ParsedDocument;
    }

    doclingFailure = await describeDoclingFailure(response);
  } catch (error) {
    doclingFailure = error instanceof Error ? error.message : String(error);
  }

  try {
    return parseDocumentLocally(file);
  } catch (fallbackError) {
    if (doclingFailure) {
      throw new Error(
        `Docling parse failed for ${file.originalname}: ${doclingFailure}`
      );
    }

    throw fallbackError;
  }
}

function parseDocumentLocally(file: Express.Multer.File): ParsedDocument {
  const isTextLike =
    file.mimetype.startsWith("text/") ||
    file.mimetype.includes("json") ||
    file.originalname.endsWith(".md") ||
    file.originalname.endsWith(".txt");

  if (!isTextLike) {
    throw new Error(
      `Docling service unavailable for ${file.originalname}. Start the Docling sidecar to parse ${file.mimetype || "binary"} files.`
    );
  }

  const raw = file.buffer.toString("utf8");
  const sections = raw
    .split(/\n(?=#{1,6}\s)|\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block, index) => ({
      sectionLabel: `Section ${index + 1}`,
      markdown: block,
      text: block.replace(/[#>*`_-]/g, " ").replace(/\s+/g, " ").trim(),
      metadata: {},
    }));

  return {
    parserName: "fallback-text-parser",
    summary: sections[0]?.text.slice(0, 160),
    pageCount: 1,
    sections,
  };
}

export function chunkParsedDocument(parsed: ParsedDocument): Array<{
  sectionLabel?: string;
  pageRange?: string;
  contentMarkdown: string;
  contentText: string;
  tokenEstimate: number;
  metadata: Record<string, unknown>;
}> {
  const chunks: Array<{
    sectionLabel?: string;
    pageRange?: string;
    contentMarkdown: string;
    contentText: string;
    tokenEstimate: number;
    metadata: Record<string, unknown>;
  }> = [];

  for (const section of parsed.sections) {
    const segments = splitText(section.text || section.markdown);
    segments.forEach((segment, index) => {
      chunks.push({
        sectionLabel: section.sectionLabel,
        pageRange: section.pageRange,
        contentMarkdown: index === 0 ? section.markdown : segment,
        contentText: segment,
        tokenEstimate: estimateTokens(segment),
        metadata: {
          ...(section.metadata ?? {}),
          parserName: parsed.parserName,
          segmentIndex: index,
        },
      });
    });
  }

  return chunks;
}

function splitText(text: string, maxChars = 1200): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/).map((paragraph) => paragraph.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length <= maxChars) {
      current = next;
      continue;
    }

    if (current) {
      chunks.push(current);
    }

    if (paragraph.length <= maxChars) {
      current = paragraph;
      continue;
    }

    for (let index = 0; index < paragraph.length; index += maxChars) {
      chunks.push(paragraph.slice(index, index + maxChars));
    }
    current = "";
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function describeDoclingFailure(response: Response): Promise<string> {
  const statusLine = `${response.status} ${response.statusText}`.trim();

  try {
    const payload = (await response.json()) as { detail?: unknown; error?: unknown };
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.error === "string"
          ? payload.error
          : null;

    if (detail) {
      return `${statusLine}: ${detail}`;
    }
  } catch {
    // Fall through to plain-text body parsing.
  }

  try {
    const body = (await response.text()).trim();
    if (body) {
      return `${statusLine}: ${body.slice(0, 400)}`;
    }
  } catch {
    // Ignore body read errors and use the status line alone.
  }

  return statusLine;
}