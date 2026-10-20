// Command migrate applies the embedded schema migrations to $DATABASE_URL (local Postgres or RDS).
package main

import (
	"context"
	"fmt"
	"os"
	"strings"

	"loanengine/packages/database"
)

func main() {
	ctx := context.Background()
	pool, err := database.Shared(ctx)
	if err == nil {
		var applied []string
		if applied, err = database.Migrate(ctx, pool); err == nil {
			if len(applied) == 0 {
				fmt.Println("schema already up to date")
			} else {
				fmt.Println("applied:", strings.Join(applied, ", "))
			}
			return
		}
	}
	fmt.Fprintln(os.Stderr, "migrate:", err)
	os.Exit(1)
}
