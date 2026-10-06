package main

import (
	"encoding/json"
	"os"
	"testing"
)

const corpusFile = "../../../fixtures/urls.json"

// A row of fixtures/urls.json: the page (nil for the command line), the href, the URL wanted (nil for no link).
type Row struct {
	Base *string `json:"base"`
	Href string  `json:"href"`
	Want *string `json:"want"`
}

func corpus(t *testing.T) []Row {
	data, err := os.ReadFile(corpusFile)
	if err != nil {
		t.Fatal(err)
	}
	var rows []Row
	if err := json.Unmarshal(data, &rows); err != nil {
		t.Fatal(err)
	}
	if len(rows) < 100 {
		t.Fatalf("%d rows: the corpus is not there", len(rows))
	}
	return rows
}

// The URL form over fixtures/urls.json, the corpus every engine resolves: one row, one printed URL or none.
func TestResolvesEveryRowOfTheCorpusAsTheFormSays(t *testing.T) {
	for _, row := range corpus(t) {
		base := ""
		got, ok := "", false
		if row.Base == nil {
			got, ok = startURL(row.Href)
		} else {
			base = *row.Base
			got, ok = resolve(base, row.Href)
		}
		switch {
		case row.Want == nil && ok:
			t.Errorf("%s + %q: want no link, got %q", base, row.Href, got)
		case row.Want != nil && !ok:
			t.Errorf("%s + %q: want %q, got no link", base, row.Href, *row.Want)
		case row.Want != nil && got != *row.Want:
			t.Errorf("%s + %q: want %q, got %q", base, row.Href, *row.Want, got)
		}
	}
}
