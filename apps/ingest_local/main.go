// Command ingest_local is local mode (no AWS): the SAME ingestion pipeline on a file, then the
// doorbell to n8n. Also the entry point the Python end-to-end tests use.
//
//	ingest_local data/demo_users.csv          (reads DATABASE_URL, N8N_WEBHOOK_URL, N8N_WEBHOOK_SECRET)
//	ingest_local --batch <uuid> file.csv      (ingest into an existing batch)
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/google/uuid"

	"loanengine/packages/batches"
	"loanengine/packages/database"
	"loanengine/packages/ingestion"
)

func main() {
	batchID := flag.String("batch", "", "existing batch id (default: create one)")
	flag.Parse()
	if flag.NArg() != 1 {
		fmt.Fprintln(os.Stderr, "usage: ingest_local [--batch <uuid>] <file.csv>")
		os.Exit(2)
	}
	if err := run(*batchID, flag.Arg(0)); err != nil {
		fmt.Fprintln(os.Stderr, "ingest_local:", err)
		os.Exit(1)
	}
}

func run(batchID, path string) error {
	ctx := context.Background()
	pool, err := database.Shared(ctx)
	if err != nil {
		return err
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	if batchID == "" {
		info, _ := f.Stat()
		batchID = uuid.NewString()
		name := filepath.Base(path)
		if err := batches.Create(ctx, pool, batchID, name, "local/"+batchID+"/"+name, max(1, info.Size()), nil, nil); err != nil {
			return err
		}
	}
	res, err := ingestion.RunReader(ctx, pool, batchID, f)
	if err != nil {
		return err
	}
	return json.NewEncoder(os.Stdout).Encode(res)
}
