from __future__ import annotations

from pathlib import Path
from tempfile import NamedTemporaryFile

from fastapi import FastAPI, File, HTTPException, UploadFile

try:
    from docling.document_converter import DocumentConverter
except Exception as exc:  # pragma: no cover
    DocumentConverter = None  # type: ignore[assignment]
    IMPORT_ERROR = exc
else:
    IMPORT_ERROR = None


app = FastAPI(title="NH-RAG Docling Sidecar")


@app.get("/health")
def health() -> dict[str, str]:
    status = "ok" if DocumentConverter is not None else "degraded"
    return {"status": status}


@app.post("/parse")
async def parse_document(file: UploadFile = File(...)) -> dict:
    if DocumentConverter is None:
    raise HTTPException(status_code=500, detail=f"Docling import failed: {IMPORT_ERROR}")

    suffix = Path(file.filename or "document.bin").suffix or ".bin"
    content = await file.read()

    with NamedTemporaryFile(delete=False, suffix=suffix) as temp_file:
        temp_file.write(content)
        temp_path = Path(temp_file.name)

    try:
        converter = DocumentConverter()
        result = converter.convert(str(temp_path))
        markdown = result.document.export_to_markdown()
        text = " ".join(markdown.replace("\r", "").split())
        sections = []

        for index, block in enumerate(filter(None, markdown.split("\n# "))):
            normalized = block if index == 0 else f"# {block}"
            plain_text = " ".join(normalized.replace("\n", " ").split())
            sections.append(
                {
                    "sectionLabel": f"Section {index + 1}",
                    "markdown": normalized,
                    "text": plain_text,
                    "metadata": {},
                }
            )

        if not sections:
            sections = [{"sectionLabel": "Section 1", "markdown": markdown, "text": text, "metadata": {}}]

        return {
            "parserName": "docling",
            "summary": text[:240],
            "pageCount": None,
            "sections": sections,
        }
    except Exception as exc:  # pragma: no cover
        raise HTTPException(status_code=500, detail=f"Docling parse failed: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)