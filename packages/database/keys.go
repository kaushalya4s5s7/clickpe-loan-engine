package database

import (
	"errors"
	"os"
	"strings"
)

// Keys is this package's environment contract, validated on first use.
type Keys struct{ URL string }

func LoadKeys() (Keys, error) {
	url := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if url == "" {
		return Keys{}, errors.New("DATABASE_URL is not set (see .env.example)")
	}
	return Keys{URL: url}, nil
}
