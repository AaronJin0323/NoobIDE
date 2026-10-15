# 跨平台 迁移 (S13.5 fixture)

A project moved between Windows and macOS. Committed: an LF page, a CRLF stylesheet, a script with mixed CRLF/LF
line breaks (`crlf-*` keep their bytes, see .gitattributes) and a Unicode (NFC) name.

Hazards a single volume or a Windows checkout cannot hold — names differing only by case, NFC/NFD twins, names
invalid on Windows — are added to a temporary copy at test time (tests/integration/portability.test.ts,
tests/e2e/portability.spec.ts) or injected as listings (src/shared/portability.test.ts).
