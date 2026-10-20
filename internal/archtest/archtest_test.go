// Package archtest is the executable form of docs/REPO-ARCHITECTURE.md.
//
// The Go compiler already enforces two rules for free: nothing outside a package can import its
// internal/ folder (the "private layer"), and import cycles don't compile. This test enforces
// the rest by parsing every non-test Go file's imports.
package archtest

import (
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"
)

const module = "loanengine/"

// allowed: package → packages it may import (docs/REPO-ARCHITECTURE.md §4).
var allowed = map[string][]string{
	"database":      {},
	"batches":       {"database"},
	"uploads":       {"batches", "database"},
	"ingestion":     {"batches", "database", "orchestration"},
	"orchestration": {},
	"notifications": {"database"},
	"reporting":     {"database"},
}

type file struct {
	rel     string // e.g. packages/uploads/uploads.go
	kind    string // packages | apps | internal
	owner   string // package or app name
	imports []string
	ast     *ast.File
}

func load(t *testing.T) []file {
	root, _ := filepath.Abs("../..")
	var out []file
	fset := token.NewFileSet()
	_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() && (d.Name() == "node_modules" || strings.HasPrefix(d.Name(), ".")) {
			if d != nil && d.IsDir() && path != root {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel, _ := filepath.Rel(root, path)
		parts := strings.Split(filepath.ToSlash(rel), "/")
		if len(parts) < 3 {
			return nil
		}
		f, perr := parser.ParseFile(fset, path, nil, parser.ImportsOnly|parser.ParseComments)
		if perr != nil {
			t.Fatal(perr)
		}
		full, _ := parser.ParseFile(fset, path, nil, 0)
		var imps []string
		for _, i := range f.Imports {
			imps = append(imps, strings.Trim(i.Path.Value, `"`))
		}
		out = append(out, file{rel: filepath.ToSlash(rel), kind: parts[0], owner: parts[1], imports: imps, ast: full})
		return nil
	})
	if len(out) == 0 {
		t.Fatal("no Go files found")
	}
	return out
}

func TestDependencyDirection(t *testing.T) {
	for _, f := range load(t) {
		for _, imp := range f.imports {
			if !strings.HasPrefix(imp, module) {
				continue
			}
			p := strings.Split(strings.TrimPrefix(imp, module), "/")
			switch {
			case p[0] == "apps" && f.kind == "packages":
				t.Errorf("%s imports %s — packages must never import apps", f.rel, imp)
			case p[0] == "apps" && f.kind == "apps" && p[1] != f.owner:
				t.Errorf("%s imports %s — apps must not import other apps", f.rel, imp)
			case p[0] == "packages" && f.kind == "packages" && p[1] != f.owner && !contains(allowed[f.owner], p[1]):
				t.Errorf("%s imports %s — dependency %s → %s is not in the allowed table", f.rel, imp, f.owner, p[1])
			}
		}
	}
	for _, f := range load(t) {
		if f.kind == "packages" {
			if _, ok := allowed[f.owner]; !ok {
				t.Errorf("package %q has no entry in the allowed table", f.owner)
			}
		}
	}
}

func TestVendorIsolation(t *testing.T) {
	for _, f := range load(t) {
		inInternal := strings.Contains(f.rel, "/internal/")
		for _, imp := range f.imports {
			switch {
			case strings.HasPrefix(imp, "github.com/aws/aws-sdk-go-v2") && !(f.kind == "packages" && inInternal):
				t.Errorf("%s imports the AWS SDK outside a package's internal/ adapter", f.rel)
			case strings.HasPrefix(imp, "github.com/aws/aws-lambda-go") && f.kind != "apps":
				t.Errorf("%s imports the Lambda runtime; only apps (the transport layer) may", f.rel)
			case strings.HasPrefix(imp, "github.com/jackc/pgx") && f.kind == "apps":
				t.Errorf("%s imports the database driver; apps use package APIs (database.Pool)", f.rel)
			}
		}
	}
}

func TestEnvironmentReadOnlyInKeysFiles(t *testing.T) {
	for _, f := range load(t) {
		if f.kind == "internal" || strings.HasSuffix(f.rel, "/keys.go") {
			continue
		}
		ast.Inspect(f.ast, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				if x, ok := sel.X.(*ast.Ident); ok && x.Name == "os" && (sel.Sel.Name == "Getenv" || sel.Sel.Name == "LookupEnv") {
					t.Errorf("%s reads the environment; config belongs in the package's keys.go", f.rel)
				}
			}
			return true
		})
	}
}

func contains(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}
