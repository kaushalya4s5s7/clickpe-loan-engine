package notifications

import (
	"errors"
	"os"
)

type Keys struct{ UnsubscribeSecret string }

func LoadKeys() (Keys, error) {
	s := os.Getenv("UNSUBSCRIBE_SECRET")
	if len(s) < 16 {
		return Keys{}, errors.New("UNSUBSCRIBE_SECRET must be at least 16 characters")
	}
	return Keys{UnsubscribeSecret: s}, nil
}
