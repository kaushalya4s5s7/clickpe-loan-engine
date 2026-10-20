package ingestion

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"io"
	"unicode/utf8"

	"golang.org/x/text/encoding/charmap"
	"golang.org/x/text/encoding/unicode"
	"golang.org/x/text/transform"
)

// Bytes → UTF-8 text, streaming, without knowing the encoding in advance.
//
// Spreadsheets arrive as UTF-8, UTF-8 with BOM (Excel "CSV UTF-8"), UTF-16 (Excel "Unicode text"),
// Windows-1252 (Excel's plain "CSV") and optionally gzipped. We sniff the first 64 KB, then stream
// the rest: memory stays constant for any file size.

const sniffBytes = 64 * 1024

// cappedReader fails once more than `left` bytes were produced: a 1 MB gzip can't expand to 100 GB.
type cappedReader struct {
	r    io.Reader
	left int64
}

func (c *cappedReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.left -= int64(n)
	if c.left < 0 {
		return n, fail("FILE_TOO_LARGE", "decompressed file exceeds the size limit")
	}
	return n, err
}

func peekHead(br *bufio.Reader) []byte {
	head, _ := br.Peek(sniffBytes) // a short file returns what exists, with an EOF we don't need
	return head
}

func detectEncoding(head []byte) string {
	switch {
	case bytes.HasPrefix(head, []byte{0xEF, 0xBB, 0xBF}):
		return "utf-8-sig"
	case bytes.HasPrefix(head, []byte{0xFF, 0xFE}), bytes.HasPrefix(head, []byte{0xFE, 0xFF}):
		return "utf-16"
	}
	// A multi-byte character cut at the 64 KB boundary is not an error: ignore an incomplete tail.
	end := len(head)
	for i := 0; i < utf8.UTFMax && end > 0 && !utf8.FullRune(head[:end]); i++ {
		end--
	}
	if utf8.Valid(head[:end]) {
		return "utf-8"
	}
	return "cp1252" // Excel's default "CSV" on Windows; decodes any byte sequence
}

// openText returns a UTF-8 stream and the detected encoding.
func openText(raw io.Reader, maxDecompressed int64) (io.Reader, string, error) {
	br := bufio.NewReaderSize(raw, sniffBytes+4096)
	head := peekHead(br)
	if bytes.HasPrefix(head, []byte{0x1f, 0x8b}) { // gzip magic number
		gz, err := gzip.NewReader(br)
		if err != nil {
			return nil, "", fail("BAD_FILE", "the file looks compressed but can't be read")
		}
		br = bufio.NewReaderSize(&cappedReader{r: gz, left: maxDecompressed}, sniffBytes+4096)
		head = peekHead(br)
	}
	if len(bytes.TrimSpace(head)) == 0 {
		return nil, "", fail("EMPTY_FILE", "the file is empty")
	}
	if bytes.HasPrefix(head, []byte("PK\x03\x04")) {
		return nil, "", fail("UNSUPPORTED_FORMAT", "this is an Excel .xlsx file; save it as CSV and upload again")
	}
	enc := detectEncoding(head)
	switch enc {
	case "utf-8-sig":
		_, _ = br.Discard(3)
		return br, enc, nil
	case "utf-16":
		return transform.NewReader(br, unicode.UTF16(unicode.LittleEndian, unicode.UseBOM).NewDecoder()), enc, nil
	case "cp1252":
		return transform.NewReader(br, charmap.Windows1252.NewDecoder()), enc, nil
	}
	return br, enc, nil
}
