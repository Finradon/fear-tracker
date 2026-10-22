UUID := fear-tracker@local
EXT := extension/$(UUID)
PORT ?= 8765

.PHONY: help serve install install-service uninstall schemas demo test check pack clean

help:
	@echo "make serve            run the overlay server in the foreground (PORT=$(PORT))"
	@echo "make install          install the GNOME extension (symlink)"
	@echo "make install-service  install the extension + systemd user service"
	@echo "make uninstall        remove both (state in ~/.config/fear-tracker is kept)"
	@echo "make demo             random-walk Fear to exercise the overlay"
	@echo "make test             run server/state tests"
	@echo "make check            tests + schema compile + JS syntax check"
	@echo "make pack             build a zip for 'gnome-extensions install'"

serve:
	python3 server/fear_server.py --port $(PORT)

install:
	scripts/install.sh

install-service:
	scripts/install.sh --service

uninstall:
	scripts/uninstall.sh

schemas:
	glib-compile-schemas --strict $(EXT)/schemas

demo:
	python3 scripts/set_fear.py --demo

test:
	python3 -m unittest discover -s tests -v

# The JS syntax check is optional and only runs if node happens to be installed.
check: test schemas
	@if command -v node >/dev/null; then \
		for f in $(EXT)/*.js; do node --check --input-type=module < $$f && echo "syntax ok: $$f" || exit 1; done; \
	else echo "node not found, skipping JS syntax check"; fi

pack: schemas
	gnome-extensions pack --force --extra-source=state.js --extra-source=icons $(EXT) -o .

clean:
	rm -f $(EXT)/schemas/gschemas.compiled $(UUID).shell-extension.zip
