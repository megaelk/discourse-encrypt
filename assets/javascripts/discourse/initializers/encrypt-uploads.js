import { withPluginApi } from "discourse/lib/plugin-api";
import { getUploadMarkdown } from "discourse/lib/uploads";
import { bufferToBase64 } from "discourse/plugins/discourse-encrypt/lib/base64";
import {
  ENCRYPT_ACTIVE,
  getEncryptionStatus,
  hasTopicKey,
} from "discourse/plugins/discourse-encrypt/lib/discourse";
import {
  generateUploadKey,
  getMetadata,
  readFile,
} from "discourse/plugins/discourse-encrypt/lib/uploads";
import UppyUploadEncrypt from "discourse/plugins/discourse-encrypt/lib/uppy-upload-encrypt-plugin";
import { DEFAULT_LIST } from "pretty-text/white-lister";
import { Promise } from "rsvp";

export default {
  name: "encrypt-uploads",

  initialize(container) {
    const currentUser = container.lookup("current-user:main");
    const siteSettings = container.lookup("site-settings:main");
    if (getEncryptionStatus(currentUser) !== ENCRYPT_ACTIVE) {
      return;
    }

    withPluginApi("0.11.3", (api) => {
      DEFAULT_LIST.push("a[data-key]");
      DEFAULT_LIST.push("a[data-type]");
      DEFAULT_LIST.push("img[data-key]");
      DEFAULT_LIST.push("img[data-type]");

      const uploads = {};

      if (!siteSettings.enable_experimental_composer_uploader) {
        this._useStableUploadProcessor(api, siteSettings, uploads);
      } else {
        this._useExperimentalComposerUploadProcessor(
          api,
          siteSettings,
          uploads
        );
      }

      api.addComposerUploadMarkdownResolver((upload) => {
        const encryptedUpload =
          uploads[upload.original_filename.replace(/\.encrypted$/, "")] ||
          Object.values(uploads).find((u) => u.filesize === upload.filesize);
        if (!encryptedUpload) {
          return;
        }

        Object.assign(upload, encryptedUpload.metadata);
        const markdown = getUploadMarkdown(upload).replace(
          "](",
          `|type=${encryptedUpload.type}|key=${encryptedUpload.key}](`
        );
        delete uploads[encryptedUpload.original_filename];
        return markdown;
      });
    });
  },

  _useStableUploadProcessor(api, siteSettings, uploads) {
    api.addComposerUploadHandler([".*"], (file, editor) => {
      const controller = api.container.lookup("controller:composer");
      const topicId = controller.get("model.topic.id");
      if (!controller.get("model.isEncrypted") && !hasTopicKey(topicId)) {
        return true;
      }

      const metadataPromise = getMetadata(file, siteSettings);
      const plaintextPromise = readFile(file);
      const keyPromise = generateUploadKey();
      const exportedKeyPromise = keyPromise.then((key) =>
        window.crypto.subtle
          .exportKey("raw", key)
          .then((wrapped) => bufferToBase64(wrapped))
      );

      const iv = window.crypto.getRandomValues(new Uint8Array(12));

      const ciphertextPromise = Promise.all([
        plaintextPromise,
        keyPromise,
      ]).then(([plaintext, key]) =>
        window.crypto.subtle.encrypt(
          { name: "AES-GCM", iv, tagLength: 128 },
          key,
          plaintext
        )
      );

      Promise.all([
        ciphertextPromise,
        exportedKeyPromise,
        metadataPromise,
      ]).then(([ciphertext, exportedKey, metadata]) => {
        const blob = new Blob([iv, ciphertext], {
          type: "application/x-binary",
        });
        const encryptedFile = new File([blob], `${file.name}.encrypted`);
        editor.$().fileupload("send", {
          files: [encryptedFile],
          originalFiles: [encryptedFile],
          formData: { type: "composer" },
        });

        uploads[file.name] = {
          key: exportedKey,
          metadata,
          type: file.type,
          filesize: encryptedFile.size,
        };
      });

      return false;
    });
  },

  _useExperimentalComposerUploadProcessor(api, siteSettings, uploads) {
    api.addComposerUploadPreProcessor(
      UppyUploadEncrypt,
      ({ composerModel }) => {
        return {
          composerModel,
          siteSettings,
          storeEncryptedUpload: (fileName, data) => {
            uploads[fileName] = data;
          },
        };
      }
    );
  },
};
