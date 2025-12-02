EXT_NAME=twitter_account_location
EXT_VERSION=1.0.1
DIST_DIR=dist/build
FIREFOX_MANIFEST=manifest.firefox.json
CHROME_MANIFEST=manifest.chrome.json

FIREFOX_ZIP=$(DIST_DIR)/$(EXT_NAME)-v$(EXT_VERSION).firefox.zip
CHROME_ZIP=$(DIST_DIR)/$(EXT_NAME)-v$(EXT_VERSION).chrome.zip

EXT_FILES=background.js cacheManager.js content.js pageScript.js popup.html popup.js README.md LICENSE logo.svg assets/*

all: firefox chrome

$(DIST_DIR):
	mkdir -p $(DIST_DIR)

firefox: $(DIST_DIR)
	cp $(FIREFOX_MANIFEST) manifest.json
	zip -r $(FIREFOX_ZIP) manifest.json $(EXT_FILES)
	rm manifest.json

chrome: $(DIST_DIR)
	cp $(CHROME_MANIFEST) manifest.json
	zip -r $(CHROME_ZIP) manifest.json $(EXT_FILES)
	rm manifest.json

clean:
	rm $(DIST_DIR)/*.zip

.PHONY: all firefox chrome clean
