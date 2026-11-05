EXT_NAME=twitter_account_location
EXT_VERSION=$(shell node -p "require('./package.json').version")
DIST_DIR=dist/build

EXT_FILES=src/background.js src/cacheManager.js src/content.js src/pageScript.js src/popup.html src/popup.js README.md LICENSE assets/*

all: firefox chrome

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

check-version:
	node -e 'const version = require("./package.json").version; for (const file of ["manifest.firefox.json", "manifest.chrome.json"]) { if (require("./" + file).version !== version) throw new Error(file + " version must match package.json (" + version + ")"); } if (process.env.RELEASE_TAG && process.env.RELEASE_TAG !== "v" + version) throw new Error("Release tag must be v" + version);'

firefox chrome: check-version | $(DIST_DIR)
	@set -eu; \
	build_dir=$$(mktemp -d); \
	trap 'rm -rf "$$build_dir"' EXIT HUP INT TERM; \
	cp manifest.$@.json "$$build_dir/manifest.json"; \
	for file in $(EXT_FILES); do \
		mkdir -p "$$build_dir/$$(dirname "$$file")"; \
		cp "$$file" "$$build_dir/$$file"; \
	done; \
	(cd "$$build_dir" && zip -r package.zip manifest.json $(EXT_FILES)); \
	mv "$$build_dir/package.zip" "$(DIST_DIR)/$(EXT_NAME)-v$(EXT_VERSION).$@.zip"

clean:
	rm -f $(DIST_DIR)/*.zip

.PHONY: all firefox chrome check-version clean
