# ADR-0040: PDFs drawn by PDFKit as PDF/UA-1, checked by veraPDF

- Status: accepted
- Date: 2026-10-14
- Requirements: NFR-12, ACC-49, ACC-50, GATE-03, DCL:DEC-11, DEC-12, DEC-13, F15, PUB-13, FL:FR-32, ADM-03

## Decision

Every PDF the platform produces (the FEMA package, issued official reports, the resident's own report, the media sheet) is drawn by **PDFKit 0.20** from a small document model in `packages/pdf` (headings, paragraphs, tables with header cells, lists, label–value pairs) in its PDF/UA mode, with **Noto Sans** embedded (SIL Open Font License, Latin including Spanish). Each kind has a synthetic sample, and CI checks every sample with **veraPDF** against PDF/UA-1 (`scripts/verapdf.sh`, image pinned by digest); a failing file fails the build. A person still checks reading order by hand per kind (`docs/a11y`).

What the writer guarantees: every piece of content is in the structure tree in reading order (H1–H3, P, L/LI, Table/TR/TH/TD with column and row header scopes and a Caption); document language and title are set and the title is shown; page numbers and the running footer are artifacts; fonts are embedded; a character the font cannot draw becomes "?" rather than an invisible glyph; an unknown value reads "Unknown", never 0 (RULE-02). The producer is the product name from configuration (ADM-03).

## Alternatives considered

| Option                                                                  | Why not                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Headless Chromium printing semantic HTML (`page.pdf({ tagged: true })`) | Chromium in the worker image adds about 300 MB to scan and patch for GovRAMP; its tagged output does not carry the PDF/UA identifier and fails veraPDF's PDF/UA-1 profile; page layout depends on the browser build. |
| Typst with PDF/UA export                                                | A second toolchain (Rust binary or WebAssembly) and a template language to maintain beside TypeScript; its PDF/UA support is newer than PDFKit's.                                                                    |
| pdf-lib / jsPDF                                                         | No structure tree or tagging; accessible output would have to be built by hand.                                                                                                                                      |
| A hosted PDF service                                                    | Sends report content off the platform; a paid third party (CLAUDE.md: ask first).                                                                                                                                    |

## Why it fits SCL-11 and the government-cloud move

Pure JavaScript with no native parts and no network calls: the same worker and API images draw the same bytes on a laptop and in a FedRAMP/GovRAMP-authorized cloud. The font ships inside the image from the npm package. veraPDF runs only in CI as a container.

## Consequences

- Layout is code, not a template: each document kind is a function from records to the document model, unit-tested, with its sample checked by veraPDF.
- PDFKit's PDF/UA mode reuses its PDF/A-1 flag and so writes a CIDSet that omits the component glyphs of accented letters, which veraPDF rejects (ISO 14289-1 7.21.4.2). The writer keeps the PDF/UA-1 identifier and writes no CIDSet (PDF/UA does not require one). Recheck when upgrading PDFKit.
- PDFKit's published TypeScript types predate its accessibility options; the writer passes them through one narrow cast.
- Charts are not drawn in PDFs in this layer; figures are tables (ACC-07: table first).
