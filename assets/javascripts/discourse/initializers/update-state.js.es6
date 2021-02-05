import getURL from "discourse-common/lib/get-url";
import { withPluginApi } from "discourse/lib/plugin-api";
import { deleteDb } from "discourse/plugins/discourse-encrypt/lib/database";
import {
  ENCRYPT_ACTIVE,
  ENCRYPT_DISABLED,
  getEncryptionStatus,
  reload,
} from "discourse/plugins/discourse-encrypt/lib/discourse";
import I18n from "I18n";

export default {
  name: "update-state",

  initialize(container) {
    const currentUser = container.lookup("current-user:main");
    const status = getEncryptionStatus(currentUser);

    if (currentUser) {
      currentUser.set("encryptStatus", status);
    }

    // Update 'encryptStatus' property of current user object when encrypt
    // status changes.
    //
    // A page refresh is usually needed when the status changes in order
    // to enable or disable parts of the plugin.
    const appEvents = container.lookup("service:app-events");
    appEvents.on("encrypt:updated", () => {
      if (currentUser) {
        const encryptStatus = getEncryptionStatus(currentUser);
        if (currentUser.encryptStatus !== encryptStatus) {
          reload();
        }
        currentUser.set("encryptStatus", encryptStatus);
      }
    });

    // Completely deactivate encrypt if user is no longer logged in or they
    // do not have encrypt active anymore.
    if (!currentUser || status !== ENCRYPT_ACTIVE) {
      deleteDb();
    }

    // Update current user if user identity changes on the server side.
    const messageBus = container.lookup("message-bus:main");
    if (messageBus && status !== ENCRYPT_DISABLED) {
      messageBus.subscribe("/plugin/encrypt/keys", function (data) {
        currentUser.setProperties({
          encrypt_public: data.public,
          encrypt_private: data.private,
        });
        appEvents.trigger("encrypt:updated");
      });
    }

    // Show warning if user does not have at least a paper key.
    if (
      currentUser &&
      status === ENCRYPT_ACTIVE &&
      (!currentUser.encrypt_private ||
        Object.keys(JSON.parse(currentUser.encrypt_private)).length === 0)
    ) {
      withPluginApi("0.8.37", (api) => {
        let basePath = getURL("/").replace(/\/$/, "");
        api.addGlobalNotice(
          I18n.t("encrypt.no_backup_warn", { basePath }),
          "key-backup-notice",
          {
            level: "warn",
            dismissable: true,
            dismissDuration: moment.duration(1, "day"),
          }
        );
      });
    }
  },
};
