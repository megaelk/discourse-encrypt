import { visit } from "@ember/test-helpers";
import User from "discourse/models/user";
import {
  deleteDb,
  loadDbIdentity,
  saveDbIdentity,
} from "discourse/plugins/discourse-encrypt/lib/database";
import EncryptLibDiscourse, {
  ENCRYPT_ACTIVE,
  ENCRYPT_DISABLED,
  ENCRYPT_ENABLED,
  getEncryptionStatus,
  getIdentity,
  resetUserIdentity,
} from "discourse/plugins/discourse-encrypt/lib/discourse";
import {
  encrypt,
  exportIdentity,
  exportKey,
  generateIdentity,
  generateKey,
  importIdentity,
} from "discourse/plugins/discourse-encrypt/lib/protocol";
import { NOTIFICATION_TYPES } from "discourse/tests/fixtures/concerns/notification-types";
import { default as userFixtures } from "discourse/tests/fixtures/user-fixtures";
import { parsePostData } from "discourse/tests/helpers/create-pretender";
import {
  acceptance,
  count,
  exists,
  query,
  queryAll,
  updateCurrentUser,
} from "discourse/tests/helpers/qunit-helpers";
import selectKit from "discourse/tests/helpers/select-kit-helper";
import I18n from "I18n";
import { test } from "qunit";
import { Promise } from "rsvp";
import sinon from "sinon";

/*
 * Checks if a string is not contained in a string.
 *
 * @param haystack
 * @param needle
 * @param message
 */
QUnit.assert.notContains = function notContains(haystack, needle, message) {
  this.pushResult({
    result: haystack.indexOf(needle) === -1,
    actual: haystack,
    expected: "not to contain " + needle,
    message,
  });
};

/**
 * @var PASSPHRASE Secret passphrase used for testing purposes.
 */
const PASSPHRASE = "curren7U$er.pa$$Phr4se";

/**
 * @var PLAINTEXT Constant string that is used to check for plaintext leakage.
 */
const PLAINTEXT = "!PL41N73X7!";

/**
 * @var keys User keys.
 */
const keys = {};

/**
 * @var globalAssert Global assert instance used to report plaintext leakage.
 */
let globalAssert;

/**
 * @var requests Request URLs intercepted by the leak checker.
 */
let requests = [];

/**
 * Sets up encryption.
 *
 * @param status
 */
async function setEncryptionStatus(status) {
  const user = User.current();

  // Resetting IndexedDB.
  try {
    await deleteDb();
  } catch (e) {}

  // Generating a new key pair if enabling or creating a dummy one if disabling.
  let identity = {};
  let exported = {};
  let exportedPrivate;
  if (status !== ENCRYPT_DISABLED) {
    identity = await generateIdentity();
    exported = await exportIdentity(identity, PASSPHRASE);
    exportedPrivate = JSON.stringify({ passphrase: exported.private });
  }

  // Overwriting server-side fields.
  user.set("encrypt_public", exported.public);
  user.set("encrypt_private", exportedPrivate);

  // Setting the appropriate custom fields is not always enough (i.e. if user
  // navigates to preferences).
  /* global server */
  server.get("/u/eviltrout.json", () => {
    const json = userFixtures["/u/eviltrout.json"];
    json.user.can_edit = true;
    json.user.encrypt_public = exported.public;
    json.user.encrypt_private = exportedPrivate;
    return [200, { "Content-Type": "application/json" }, json];
  });

  // Activating encryption on client-side.
  if (status === ENCRYPT_ACTIVE) {
    await saveDbIdentity(identity);
  }

  keys[user.username] = exported.public;
  return identity;
}

/**
 * Executes the given function and waits until current encryption status
 * changes or given waiter becomes true.
 *
 * @param statusOrWaiter
 * @param func
 */
async function wait(statusOrWaiter, func) {
  const waiter =
    typeof statusOrWaiter === "function"
      ? statusOrWaiter
      : () => getEncryptionStatus(User.current()) === statusOrWaiter;

  try {
    Ember.Test.registerWaiter(waiter);
    await func();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(`Caught exception while waiting: ${e.message}`, e);
  } finally {
    Ember.Test.unregisterWaiter(waiter);
  }
}

acceptance("Encrypt", function (needs) {
  needs.user({ can_encrypt: true });
  needs.settings({ encrypt_pms_default: true });

  needs.hooks.beforeEach(() => {
    sinon.stub(EncryptLibDiscourse, "reload");

    // Hook `XMLHttpRequest` to search for leaked plaintext.
    XMLHttpRequest.prototype.send_ = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
      requests.push(this.url);
      if (body && globalAssert) {
        globalAssert.notContains(body, PLAINTEXT, "does not leak plaintext");
        globalAssert.notContains(body, PASSPHRASE, "does not leak passphrase");
      }
      return this.send_(...arguments);
    };

    resetUserIdentity();
  });

  needs.hooks.afterEach(() => {
    // Restore `XMLHttpRequest`.
    XMLHttpRequest.prototype.send = XMLHttpRequest.prototype.send_;
    delete XMLHttpRequest.prototype.send_;

    globalAssert = null;
  });

  needs.pretender((server, helper) => {
    server.get("/encrypt/user", (request) => {
      const response = {};
      request.queryParams["usernames"].forEach((u) => (response[u] = keys[u]));
      return helper.response(response);
    });

    server.get("/encrypt/posts", () => {
      return helper.response({ posts: [], topics: [] });
    });

    server.put("/encrypt/post", () => {
      return helper.response({});
    });
  });

  test("meta: leak checker works", async (assert) => {
    globalAssert = { notContains: () => assert.ok(true) };

    await visit("/");
    await click("#create-topic");

    requests = [];
    await fillIn("#reply-title", `Some hidden message ${PLAINTEXT}`);
    await fillIn(".d-editor-input", `Hello, world! ${PLAINTEXT}`.repeat(42));
    await wait(
      () => requests.includes("/posts"),
      () => click("button.create")
    );
  });

  test("posting does not leak plaintext", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);
    globalAssert = assert;

    /* global server */
    server.get("/u/search/users", () => {
      return [
        200,
        { "Content-Type": "application/json" },
        {
          users: [
            {
              username: "eviltrout",
              name: "eviltrout",
              avatar_template: "/images/avatar.png",
            },
          ],
        },
      ];
    });

    server.post("/posts", (request) => {
      const body = parsePostData(request.requestBody);

      assert.equal(body.raw, I18n.t("encrypt.encrypted_post"));
      assert.equal(body.title, I18n.t("encrypt.encrypted_title"));
      assert.equal(body.archetype, "private_message");
      assert.equal(body.target_recipients, "eviltrout");
      assert.equal(body.draft_key, "new_topic");
      assert.equal(body.is_encrypted, "true");
      assert.ok(body.encrypted_title.startsWith("1$"));
      assert.ok(body.encrypted_raw.startsWith("1$"));
      assert.ok(JSON.parse(body.encrypted_keys).eviltrout);

      return [
        200,
        { "Content-Type": "application/json" },
        { action: "create_post", post: { topic_id: 34 } },
      ];
    });

    const composerActions = selectKit(".composer-actions");

    await visit("/");
    await click("#create-topic");
    await composerActions.expand();
    await composerActions.selectRowByValue("reply_as_private_message");

    // simulate selecting from autocomplete suggestions
    const usersSelector = selectKit("#private-message-users");
    await usersSelector.expand();
    await usersSelector.fillInFilter("evilt");
    await usersSelector.selectRowByValue("eviltrout");

    requests = [];
    await wait(
      () => requests.includes("/drafts.json"),
      async () => {
        await fillIn("#reply-title", `Some hidden message ${PLAINTEXT}`);
        await fillIn(
          ".d-editor-input",
          `Hello, world! ${PLAINTEXT}`.repeat(42)
        );
      }
    );

    requests = [];
    await wait(
      () => requests.includes("/posts") && requests.includes("/encrypt/post"),
      () => click("button.create")
    );
  });

  test("new draft for public topic is not encrypted", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);

    server.post("/drafts.json", (request) => {
      const data = JSON.parse(parsePostData(request.requestBody).data);
      if (data.title) {
        assert.equal(data.title, `Some public message ${PLAINTEXT}`);
      }
      if (data.reply) {
        assert.equal(data.reply, `Hello, world! ${PLAINTEXT}`.repeat(42));
      }
      return [200, { "Content-Type": "application/json" }, {}];
    });

    await visit("/");
    await click("#create-topic");
    await fillIn("#reply-title", `Some public message ${PLAINTEXT}`);
    await fillIn(".d-editor-input", `Hello, world! ${PLAINTEXT}`.repeat(42));

    requests = [];
    await wait(
      () => requests.includes("/drafts.json"),
      () => click(".toggler")
    );
  });

  test("enabling works", async (assert) => {
    await setEncryptionStatus(ENCRYPT_DISABLED);

    let ajaxRequested = false;
    /* global server */
    server.put("/encrypt/keys", () => {
      ajaxRequested = true;
      return [200, { "Content-Type": "application/json" }, { success: "OK" }];
    });

    await visit("/u/eviltrout/preferences/security");
    await wait(ENCRYPT_ACTIVE, () => click(".encrypt button.btn-primary"));
    assert.ok(ajaxRequested, "AJAX request to save keys was made");

    const identity = await loadDbIdentity();
    assert.ok(identity.encryptPublic instanceof CryptoKey);
    assert.ok(identity.encryptPrivate instanceof CryptoKey);
    assert.ok(identity.signPublic instanceof CryptoKey);
    assert.ok(identity.signPrivate instanceof CryptoKey);
  });

  test("activation works", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ENABLED);

    await visit("/u/eviltrout/preferences/security");
    await fillIn(".encrypt #passphrase", PASSPHRASE);
    await wait(ENCRYPT_ACTIVE, () => click(".encrypt button.btn-primary"));

    const identity = await loadDbIdentity();
    assert.ok(identity.encryptPublic instanceof CryptoKey);
    assert.ok(identity.encryptPrivate instanceof CryptoKey);
    assert.ok(identity.signPublic instanceof CryptoKey);
    assert.ok(identity.signPrivate instanceof CryptoKey);
  });

  test("deactivation works", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);

    await visit("/u/eviltrout/preferences/security");
    await wait(ENCRYPT_ENABLED, () => click(".encrypt button#deactivate"));

    assert.rejects(loadDbIdentity());
  });

  test("viewing encrypted topic works when just enabled", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ENABLED);
    globalAssert = assert;

    const identities = JSON.parse(User.current().encrypt_private);
    const identity = await importIdentity(identities["passphrase"], PASSPHRASE);
    const topicKey = await generateKey();
    const exportedTopicKey = await exportKey(topicKey, identity.encryptPublic);
    const encryptedTitle = await encrypt(topicKey, { raw: "Top Secret Title" });
    const encryptedRaw = await encrypt(topicKey, { raw: "Top Secret Post" });

    server.get("/t/42.json", () => {
      return [
        200,
        { "Content-Type": "application/json" },
        {
          post_stream: {
            posts: [
              {
                id: 42,
                name: null,
                username: "bar",
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
                created_at: "2020-01-01T12:00:00.000Z",
                cooked:
                  "<p>This is a secret message with end to end encryption. To view it, you must be invited to this topic.</p>",
                post_number: 1,
                post_type: 1,
                updated_at: "2020-01-01T12:00:00.000Z",
                reply_count: 0,
                reply_to_post_number: null,
                quote_count: 0,
                incoming_link_count: 0,
                reads: 2,
                readers_count: 1,
                score: 0.4,
                yours: false,
                topic_id: 42,
                topic_slug: "a-secret-message",
                display_username: null,
                primary_group_name: null,
                primary_group_flair_url: null,
                primary_group_flair_bg_color: null,
                primary_group_flair_color: null,
                version: 1,
                can_edit: true,
                can_delete: false,
                can_recover: false,
                can_wiki: true,
                read: true,
                user_title: null,
                title_is_group: false,
                bookmarked: false,
                actions_summary: [
                  {
                    id: 2,
                    can_act: true,
                  },
                  {
                    id: 3,
                    can_act: true,
                  },
                  {
                    id: 4,
                    can_act: true,
                  },
                  {
                    id: 8,
                    can_act: true,
                  },
                  {
                    id: 6,
                    can_act: true,
                  },
                  {
                    id: 7,
                    can_act: true,
                  },
                ],
                moderator: false,
                admin: true,
                staff: true,
                user_id: 2,
                hidden: false,
                trust_level: 0,
                deleted_at: null,
                user_deleted: false,
                edit_reason: null,
                can_view_edit_history: true,
                wiki: false,
                reviewable_id: 0,
                reviewable_score_count: 0,
                reviewable_score_pending_count: 0,
                encrypted_raw: encryptedRaw,
              },
            ],
            stream: [42],
          },
          timeline_lookup: [[1, 0]],
          related_messages: [],
          suggested_topics: [],
          id: 42,
          title: "A secret message",
          fancy_title: "A secret message",
          posts_count: 1,
          created_at: "2020-01-01T12:00:00.000Z",
          views: 2,
          reply_count: 0,
          like_count: 0,
          last_posted_at: "2020-01-01T12:00:00.000Z",
          visible: true,
          closed: false,
          archived: false,
          has_summary: false,
          archetype: "private_message",
          slug: "a-secret-message",
          category_id: null,
          word_count: 16,
          deleted_at: null,
          user_id: 2,
          featured_link: null,
          pinned_globally: false,
          pinned_at: null,
          pinned_until: null,
          image_url: null,
          slow_mode_seconds: 0,
          draft: null,
          draft_key: "topic_42",
          draft_sequence: 0,
          posted: false,
          unpinned: null,
          pinned: false,
          current_post_number: 1,
          highest_post_number: 1,
          last_read_post_number: 1,
          last_read_post_id: 42,
          deleted_by: null,
          has_deleted: false,
          actions_summary: [
            {
              id: 4,
              count: 0,
              hidden: false,
              can_act: true,
            },
            {
              id: 8,
              count: 0,
              hidden: false,
              can_act: true,
            },
            {
              id: 7,
              count: 0,
              hidden: false,
              can_act: true,
            },
          ],
          chunk_size: 20,
          bookmarked: false,
          message_archived: false,
          topic_timer: null,
          message_bus_last_id: 3,
          participant_count: 1,
          pm_with_non_human_user: false,
          queued_posts_count: 0,
          show_read_indicator: false,
          requested_group_name: null,
          thumbnails: null,
          slow_mode_enabled_until: null,
          encrypted_title: encryptedTitle,
          topic_key: exportedTopicKey,
          details: {
            can_edit: true,
            notification_level: 3,
            notifications_reason_id: 2,
            can_move_posts: true,
            can_delete: true,
            can_remove_allowed_users: true,
            can_invite_to: true,
            can_invite_via_email: true,
            can_create_post: true,
            can_reply_as_new_topic: true,
            can_flag_topic: true,
            can_convert_topic: true,
            can_review_topic: true,
            can_close_topic: true,
            can_archive_topic: true,
            can_split_merge_topic: true,
            can_edit_staff_notes: true,
            can_toggle_topic_visibility: true,
            can_pin_unpin_topic: true,
            can_moderate_category: true,
            can_remove_self_id: 1,
            participants: [
              {
                id: 2,
                username: "bar",
                name: null,
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
                post_count: 1,
                primary_group_name: null,
                primary_group_flair_url: null,
                primary_group_flair_color: null,
                primary_group_flair_bg_color: null,
                admin: true,
                trust_level: 0,
              },
            ],
            allowed_users: [
              {
                id: 1,
                username: "foo",
                name: null,
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/f/000000/{size}.png",
              },
              {
                id: 2,
                username: "bar",
                name: null,
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
              },
            ],
            created_by: {
              id: 2,
              username: "bar",
              name: null,
              avatar_template:
                "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
            },
            last_poster: {
              id: 2,
              username: "bar",
              name: null,
              avatar_template:
                "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
            },
            allowed_groups: [],
          },
          pending_posts: [],
        },
      ];
    });

    await visit("/t/a-secret-message/42");
    await visit("/t/a-secret-message/42"); // wait for re-render
    assert.ok(exists(".modal.activate-encrypt-modal"));
  });

  test("viewing encrypted topic works when active", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);
    globalAssert = assert;

    const identity = await getIdentity();
    const topicKey = await generateKey();
    const exportedTopicKey = await exportKey(topicKey, identity.encryptPublic);
    const encryptedTitle = await encrypt(topicKey, { raw: "Top Secret Title" });
    const encryptedRaw = await encrypt(topicKey, { raw: "Top Secret Post" });

    server.get("/t/42.json", () => {
      return [
        200,
        { "Content-Type": "application/json" },
        {
          post_stream: {
            posts: [
              {
                id: 42,
                name: null,
                username: "bar",
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
                created_at: "2020-01-01T12:00:00.000Z",
                cooked:
                  "<p>This is a secret message with end to end encryption. To view it, you must be invited to this topic.</p>",
                post_number: 1,
                post_type: 1,
                updated_at: "2020-01-01T12:00:00.000Z",
                reply_count: 0,
                reply_to_post_number: null,
                quote_count: 0,
                incoming_link_count: 0,
                reads: 2,
                readers_count: 1,
                score: 0.4,
                yours: false,
                topic_id: 42,
                topic_slug: "a-secret-message",
                display_username: null,
                primary_group_name: null,
                primary_group_flair_url: null,
                primary_group_flair_bg_color: null,
                primary_group_flair_color: null,
                version: 1,
                can_edit: true,
                can_delete: false,
                can_recover: false,
                can_wiki: true,
                read: true,
                user_title: null,
                title_is_group: false,
                bookmarked: false,
                actions_summary: [
                  {
                    id: 2,
                    can_act: true,
                  },
                  {
                    id: 3,
                    can_act: true,
                  },
                  {
                    id: 4,
                    can_act: true,
                  },
                  {
                    id: 8,
                    can_act: true,
                  },
                  {
                    id: 6,
                    can_act: true,
                  },
                  {
                    id: 7,
                    can_act: true,
                  },
                ],
                moderator: false,
                admin: true,
                staff: true,
                user_id: 2,
                hidden: false,
                trust_level: 0,
                deleted_at: null,
                user_deleted: false,
                edit_reason: null,
                can_view_edit_history: true,
                wiki: false,
                reviewable_id: 0,
                reviewable_score_count: 0,
                reviewable_score_pending_count: 0,
                encrypted_raw: encryptedRaw,
              },
            ],
            stream: [42],
          },
          timeline_lookup: [[1, 0]],
          related_messages: [],
          suggested_topics: [],
          id: 42,
          title: "A secret message",
          fancy_title: "A secret message",
          posts_count: 1,
          created_at: "2020-01-01T12:00:00.000Z",
          views: 2,
          reply_count: 0,
          like_count: 0,
          last_posted_at: "2020-01-01T12:00:00.000Z",
          visible: true,
          closed: false,
          archived: false,
          has_summary: false,
          archetype: "private_message",
          slug: "a-secret-message",
          category_id: null,
          word_count: 16,
          deleted_at: null,
          user_id: 2,
          featured_link: null,
          pinned_globally: false,
          pinned_at: null,
          pinned_until: null,
          image_url: null,
          slow_mode_seconds: 0,
          draft: null,
          draft_key: "topic_42",
          draft_sequence: 0,
          posted: false,
          unpinned: null,
          pinned: false,
          current_post_number: 1,
          highest_post_number: 1,
          last_read_post_number: 1,
          last_read_post_id: 42,
          deleted_by: null,
          has_deleted: false,
          actions_summary: [
            {
              id: 4,
              count: 0,
              hidden: false,
              can_act: true,
            },
            {
              id: 8,
              count: 0,
              hidden: false,
              can_act: true,
            },
            {
              id: 7,
              count: 0,
              hidden: false,
              can_act: true,
            },
          ],
          chunk_size: 20,
          bookmarked: false,
          message_archived: false,
          topic_timer: null,
          message_bus_last_id: 3,
          participant_count: 1,
          pm_with_non_human_user: false,
          queued_posts_count: 0,
          show_read_indicator: false,
          requested_group_name: null,
          thumbnails: null,
          slow_mode_enabled_until: null,
          encrypted_title: encryptedTitle,
          topic_key: exportedTopicKey,
          details: {
            can_edit: true,
            notification_level: 3,
            notifications_reason_id: 2,
            can_move_posts: true,
            can_delete: true,
            can_remove_allowed_users: true,
            can_invite_to: true,
            can_invite_via_email: true,
            can_create_post: true,
            can_reply_as_new_topic: true,
            can_flag_topic: true,
            can_convert_topic: true,
            can_review_topic: true,
            can_close_topic: true,
            can_archive_topic: true,
            can_split_merge_topic: true,
            can_edit_staff_notes: true,
            can_toggle_topic_visibility: true,
            can_pin_unpin_topic: true,
            can_moderate_category: true,
            can_remove_self_id: 1,
            participants: [
              {
                id: 2,
                username: "bar",
                name: null,
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
                post_count: 1,
                primary_group_name: null,
                primary_group_flair_url: null,
                primary_group_flair_color: null,
                primary_group_flair_bg_color: null,
                admin: true,
                trust_level: 0,
              },
            ],
            allowed_users: [
              {
                id: 1,
                username: "foo",
                name: null,
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/f/000000/{size}.png",
              },
              {
                id: 2,
                username: "bar",
                name: null,
                avatar_template:
                  "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
              },
            ],
            created_by: {
              id: 2,
              username: "bar",
              name: null,
              avatar_template:
                "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
            },
            last_poster: {
              id: 2,
              username: "bar",
              name: null,
              avatar_template:
                "/letter_avatar_proxy/v4/letter/b/000000/{size}.png",
            },
            allowed_groups: [],
          },
          pending_posts: [],
        },
      ];
    });

    await visit("/t/a-secret-message/42");
    await visit("/t/a-secret-message/42"); // wait for re-render
    assert.equal(query(".fancy-title").innerText.trim(), "Top Secret Title");
    assert.equal(query(".cooked").innerText.trim(), "Top Secret Post");
    assert.equal(document.title, "Top Secret Title - QUnit Discourse Tests");
  });

  test("encrypt settings visible only if user can encrypt", async (assert) => {
    await setEncryptionStatus(ENCRYPT_DISABLED);

    await visit("/u/eviltrout/preferences/security");
    assert.ok(
      find(".encrypt").text().length > 0,
      "encrypt settings are visible"
    );

    updateCurrentUser({ can_encrypt: false });

    await visit("/u/eviltrout/preferences");
    await click(".nav-security a");
    assert.ok(
      find(".encrypt").text().length === 0,
      "encrypt settings are not visible"
    );

    updateCurrentUser({ can_encrypt: true });

    await visit("/u/eviltrout/preferences");
    await click(".nav-security a");
    assert.ok(
      find(".encrypt").text().length > 0,
      "encrypt settings are visible"
    );
  });

  test("user preferences connector works for other users", async (assert) => {
    await setEncryptionStatus(ENCRYPT_DISABLED);

    /* global server */
    server.get("/u/eviltrout2.json", () => {
      const json = JSON.parse(
        JSON.stringify(userFixtures["/u/eviltrout.json"])
      );
      json.user.id += 1;
      json.user.can_edit = true;
      json.user.can_encrypt = true;
      json.user.encrypt_public = "encrypted public identity";
      return [200, { "Content-Type": "application/json" }, json];
    });

    await visit("/u/eviltrout2/preferences/security");

    assert.ok(
      find(".user-preferences-security-outlet.encrypt")
        .text()
        .trim()
        .indexOf(I18n.t("encrypt.preferences.status_enabled_other")) !== -1
    );
  });

  test("topic titles in notification panel are decrypted", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);

    const identity = await getIdentity();
    const topicKey = await generateKey();
    const exportedKey = await exportKey(topicKey, identity.encryptPublic);
    const title = "Top Secret :male_detective:";
    const encryptedTitle = await encrypt(topicKey, { raw: title });

    /* global server */
    server.get("/notifications", () => [
      200,
      { "Content-Type": "application/json" },
      {
        notifications: [
          {
            id: 42,
            user_id: 1,
            notification_type: NOTIFICATION_TYPES.private_message,
            read: false,
            created_at: "2020-01-01T12:12:12.000Z",
            post_number: 1,
            topic_id: 42,
            fancy_title: "A Secret Message",
            slug: "a-secret-message",
            data: {
              topic_title: "A Secret Message",
              original_post_id: 42,
              original_post_type: 1,
              original_username: "foo",
              revision_number: null,
              display_username: "foo",
            },
            encrypted_title: encryptedTitle,
            topic_key: exportedKey,
          },
        ],
        total_rows_notifications: 1,
        seen_notification_id: 5,
        load_more_notifications: "/notifications?offset=60&username=foo",
      },
    ]);

    const stub = sinon.stub(EncryptLibDiscourse, "syncGetTopicTitle");
    stub.returns("Top Secret :male_detective:");

    const stub2 = sinon.stub(EncryptLibDiscourse, "getTopicTitle");
    stub2.returns(Promise.resolve("Top Secret :male_detective:"));

    const stub3 = sinon.stub(EncryptLibDiscourse, "waitForPendingTitles");
    stub3.returns(Promise.resolve());

    await visit("/");
    await click(".header-dropdown-toggle.current-user");

    assert.equal(
      find(".quick-access-panel span[data-topic-id]").text(),
      "Top Secret "
    );
    assert.equal(find(".quick-access-panel span[data-topic-id] img").length, 1);
  });

  test("searching in encrypted topic titles", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);

    const identity = await getIdentity();
    const topicKey = await generateKey();
    const exportedKey = await exportKey(topicKey, identity.encryptPublic);
    const title = "Top Secret :male_detective:";
    const encryptedTitle = await encrypt(topicKey, { raw: title });

    /* global server */
    server.get("/search", (request) => {
      return [
        200,
        { "Content-Type": "application/json" },
        {
          posts: [],
          topics: [],
          grouped_search_result: {
            term: request.queryParams.q,
            type_filter: "private_messages",
            post_ids: [],
          },
        },
      ];
    });

    /* global server */
    server.get("/encrypt/posts", () => {
      return [
        200,
        { "Content-Type": "application/json" },
        {
          success: "OK",
          topics: [
            {
              id: 42,
              title: "A secret message",
              fancy_title: "A secret message",
              slug: "a-secret-message",
              posts_count: 1,
              reply_count: 0,
              highest_post_number: 1,
              created_at: "2021-01-01T12:00:00.000Z",
              last_posted_at: "2021-01-01T12:00:00.000Z",
              bumped: true,
              bumped_at: "2021-01-01T12:00:00.000Z",
              archetype: "private_message",
              unseen: false,
              pinned: false,
              unpinned: null,
              visible: true,
              closed: false,
              archived: false,
              bookmarked: null,
              liked: null,
              category_id: null,
              encrypted_title: encryptedTitle,
              topic_key: exportedKey,
            },
          ],
          posts: [
            {
              id: 42,
              username: "foo",
              avatar_template:
                "/letter_avatar_proxy/v4/letter/f/eada6e/{size}.png",
              created_at: "2021-01-01T12:00:00.000Z",
              like_count: 0,
              post_number: 1,
              topic_id: 42,
            },
            {
              id: 43,
              username: "foo",
              avatar_template:
                "/letter_avatar_proxy/v4/letter/f/eada6e/{size}.png",
              created_at: "2021-01-01T12:00:00.000Z",
              like_count: 0,
              post_number: 2,
              topic_id: 42,
            },
          ],
        },
      ];
    });

    await visit("/search?q=secret+in:personal");
    assert.equal(count(".fps-result"), 1);
    assert.equal(
      queryAll(".fps-result .topic-title").text().trim(),
      "Top Secret"
    );

    /* global server */
    server.get("/search", (request) => {
      return [
        200,
        { "Content-Type": "application/json" },
        {
          posts: [
            {
              id: 42,
              username: "foo",
              avatar_template:
                "/letter_avatar_proxy/v4/letter/f/eada6e/{size}.png",
              created_at: "2021-01-01T12:00:00.000Z",
              like_count: 0,
              blurb:
                'This is a <span class="search-highlight">secret</span> message with end to end encryption. To view it, you must be invited to this topic...',
              post_number: 1,
              topic_title_headline:
                'A <span class="search-highlight">secret</span> message',
              topic_id: 42,
            },
          ],
          topics: [
            {
              id: 42,
              title: "A secret message",
              fancy_title: "A secret message",
              slug: "a-secret-message",
              posts_count: 1,
              reply_count: 0,
              highest_post_number: 1,
              created_at: "2021-01-01T12:00:00.000Z",
              last_posted_at: "2021-01-01T12:00:00.000Z",
              bumped: true,
              bumped_at: "2021-01-01T12:00:00.000Z",
              archetype: "private_message",
              unseen: false,
              last_read_post_number: 1,
              unread: 0,
              new_posts: 0,
              pinned: false,
              unpinned: null,
              visible: true,
              closed: false,
              archived: false,
              notification_level: 3,
              bookmarked: false,
              liked: false,
              category_id: null,
              encrypted_title: encryptedTitle,
              topic_key: exportedKey,
            },
          ],
          users: [],
          categories: [],
          tags: [],
          groups: [],
          grouped_search_result: {
            more_posts: null,
            more_users: null,
            more_categories: null,
            term: request.queryParams.q,
            search_log_id: 42,
            more_full_page_results: null,
            can_create_topic: true,
            error: null,
            type_filter: "private_messages",
            post_ids: [42],
            user_ids: [],
            category_ids: [],
            tag_ids: [],
            group_ids: [],
          },
        },
      ];
    });

    await visit("/search?q=secret++in:personal");
    assert.equal(count(".fps-result"), 1);
    assert.equal(
      queryAll(".fps-result .topic-title").text().trim(),
      "Top Secret"
    );
  });

  test("searching in bookmarks", async (assert) => {
    await setEncryptionStatus(ENCRYPT_ACTIVE);

    const identity = await getIdentity();

    const topicKey = await generateKey();
    const exportedTopicKey = await exportKey(topicKey, identity.encryptPublic);
    const encryptedTitle = await encrypt(topicKey, { raw: "Top Secret Title" });

    const topicKey2 = await generateKey();
    const exportedTopicKey2 = await exportKey(
      topicKey2,
      identity.encryptPublic
    );
    const encryptedTitle2 = await encrypt(topicKey2, { raw: "Not a Secret" });

    server.get("/u/eviltrout/bookmarks.json", (request) => {
      if (request.queryParams.q) {
        return [
          200,
          { "Content-Type": "application/json" },
          {
            bookmarks: [],
            no_results_help:
              "No bookmarks found with the provided search query.",
          },
        ];
      }

      return [
        200,
        { "Content-Type": "application/json" },
        {
          user_bookmark_list: {
            more_bookmarks_url: "/u/eviltrout/bookmarks.json?page=1",
            bookmarks: [
              {
                excerpt: "",
                id: 42,
                created_at: "2020-01-01T12:00:00.000Z",
                updated_at: "2020-01-01T12:00:00.000Z",
                topic_id: 42,
                linked_post_number: 1,
                post_id: 42,
                name: null,
                reminder_at: null,
                pinned: false,
                title: "A secret message",
                fancy_title: "A secret message",
                deleted: false,
                hidden: false,
                category_id: null,
                closed: false,
                archived: false,
                archetype: "private_message",
                highest_post_number: 1,
                bumped_at: "2020-01-01T12:00:00.000Z",
                slug: "a-secret-message",
                post_user_username: "foo",
                post_user_avatar_template:
                  "/letter_avatar_proxy/v4/letter/f/eada6e/{size}.png",
                post_user_name: null,
                encrypted_title: encryptedTitle,
                topic_key: exportedTopicKey,
              },
              {
                excerpt: "",
                id: 43,
                created_at: "2020-01-01T12:00:00.000Z",
                updated_at: "2020-01-01T12:00:00.000Z",
                topic_id: 43,
                linked_post_number: 1,
                post_id: 43,
                name: null,
                reminder_at: null,
                pinned: false,
                title: "A secret message",
                fancy_title: "A secret message",
                deleted: false,
                hidden: false,
                category_id: null,
                closed: false,
                archived: false,
                archetype: "private_message",
                highest_post_number: 1,
                bumped_at: "2020-01-01T12:00:00.000Z",
                slug: "a-secret-message",
                post_user_username: "foo",
                post_user_avatar_template:
                  "/letter_avatar_proxy/v4/letter/f/eada6e/{size}.png",
                post_user_name: null,
                encrypted_title: encryptedTitle2,
                topic_key: exportedTopicKey2,
              },
            ],
          },
        },
      ];
    });

    await visit("/u/eviltrout/activity/bookmarks");
    await visit("/u/eviltrout/activity/bookmarks"); // wait for re-render

    assert.equal(count(".bookmark-list-item"), 2);
    assert.equal(
      queryAll(".bookmark-list-item .title")[0].innerText.trim(),
      "Top Secret Title"
    );
    assert.equal(
      queryAll(".bookmark-list-item .title")[1].innerText.trim(),
      "Not a Secret"
    );

    await visit("/");
    await visit("/u/eviltrout/activity/bookmarks?q=Top");

    assert.equal(count(".bookmark-list-item"), 1);
    assert.equal(
      queryAll(".bookmark-list-item .title")[0].innerText.trim(),
      "Top Secret Title"
    );
  });
});
