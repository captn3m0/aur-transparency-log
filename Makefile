PAGES ?= .pages

.PHONY: docs
docs: $(PAGES)
	pandoc -f gfm -t html --template docs/template.html --metadata title=Usage USAGE.md -o $(PAGES)/usage.html

$(PAGES):
	git worktree add $(PAGES) gh-pages
