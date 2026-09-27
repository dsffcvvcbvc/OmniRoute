"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Badge, Button, Card, ConfirmModal, Input } from "@/shared/components";
import {
  createProviderKey,
  deleteProviderKey,
  fetchProviderKeys,
  updateProviderKey,
  type AisixProviderKeyEntry,
  type ProviderKeyWriteFailureKind,
  type ProviderKeyWriteOutcome,
} from "@/shared/utils/aisixProviderKeys";
import { providerText, type ProviderMessageTranslator } from "../[id]/providerCredentialText";

/**
 * `missing`  — this gateway build has no `/admin/v1/provider_keys` surface.
 * `denied`   — it HAS the surface and answered 401/403: it wants an admin key.
 * `error`    — anything else. The list is unknown, not empty.
 */
type KeysLoadState = "loading" | "ready" | "missing" | "denied" | "error";

type EditorState = { mode: "create" } | { mode: "edit"; entry: AisixProviderKeyEntry } | null;

interface FormState {
  displayName: string;
  apiKey: string;
  provider: string;
  apiBase: string;
}

const EMPTY_FORM: FormState = { displayName: "", apiKey: "", provider: "", apiBase: "" };

/**
 * One line the operator can act on, derived from the gateway's own `error_msg`.
 *
 * The server's message is passed through verbatim and untranslated because it
 * NAMES the refusal ("still referenced by 1 (model \"x\")", "holds 1 resource(s)
 * outside `provider_keys`") — a translated paraphrase would lose the only
 * actionable part. The `failure` kind picks the surrounding framing.
 */
function describeWriteFailure(
  failure: ProviderKeyWriteFailureKind,
  reason: string | null,
  text: (key: string, fallback: string) => string
): string {
  const detail = reason && reason.trim().length > 0 ? ` — ${reason}` : "";
  switch (failure) {
    case "unauthorized":
      return `${text("providerKeysSaveUnauthorized", "The gateway refused this change: no admin key.")}${detail}`;
    case "invalid":
      return `${text("providerKeysSaveInvalid", "The gateway rejected this document.")}${detail}`;
    case "not_found":
      return `${text("providerKeysSaveNotFound", "The gateway no longer has this key.")}${detail}`;
    case "conflict":
      return `${text("providerKeysSaveConflict", "The gateway refused: the name is taken, or the key is still referenced.")}${detail}`;
    case "not_persisted":
      return `${text("providerKeysNotPersisted", "Applied in memory but NOT written to disk: the resources file holds rows a per-key write cannot re-emit. It will be lost on reload — use POST /admin/v1/resources.")}${detail}`;
    case "unsupported":
      return `${text("providerKeysWritesUnsupported", "This gateway build has no provider-key write surface.")}${detail}`;
    default:
      return `${text("providerKeysSaveFailed", "The gateway refused this change.")}${detail}`;
  }
}

/**
 * Upstream provider-key CRUD against `GET|POST /admin/v1/provider_keys` and
 * `GET|PATCH|DELETE /admin/v1/provider_keys/:id`.
 *
 * The rules this surface follows, all of them consequences of the Rust handler
 * rather than of convenience:
 *
 *   - the list is the SERVER's documents; a mutation replaces the row with the
 *     response body, never with an optimistic local guess;
 *   - a refused write changes nothing in the list and shows the gateway's own
 *     reason, including the 409 that names the models still referencing a key;
 *   - the 500 "not written to disk" refusal is reported as exactly that, because
 *     the handler mutates the snapshot before it discovers the file cannot hold
 *     the write — reporting it as a success would tell the operator a credential
 *     is stored when a reload drops it;
 *   - delete always confirms first, and its 409 path is a first-class outcome
 *     rather than a swallowed error.
 */
export default function ProviderKeysSection() {
  const t = useTranslations("providers");
  const tCommon = useTranslations("common");
  const text = (key: string, fallback: string, values?: Record<string, unknown>) =>
    providerText(t as ProviderMessageTranslator, key, fallback, values);

  const [state, setState] = useState<KeysLoadState>("loading");
  const [entries, setEntries] = useState<AisixProviderKeyEntry[]>([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [editor, setEditor] = useState<EditorState>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; message: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<AisixProviderKeyEntry | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setState("loading");
      const result = await fetchProviderKeys();
      if (cancelled) return;
      if (result.missing) {
        setEntries([]);
        setState("missing");
        return;
      }
      if (result.status === 401 || result.status === 403) {
        setEntries([]);
        setState("denied");
        return;
      }
      if (result.status < 200 || result.status >= 300) {
        setEntries([]);
        setState("error");
        return;
      }
      setEntries(result.entries);
      setState("ready");
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setEditor({ mode: "create" });
  };

  const openEdit = (entry: AisixProviderKeyEntry) => {
    setForm({
      displayName: entry.value.display_name,
      // The stored secret is never round-tripped through the form: the core
      // answers with it, but re-sending it would put it in a DOM field and in
      // the update payload for no reason. An empty box means "leave it alone".
      apiKey: "",
      provider: entry.value.provider ?? "",
      apiBase: entry.value.api_base ?? "",
    });
    setFormError(null);
    setEditor({ mode: "edit", entry });
  };

  const closeEditor = () => {
    setEditor(null);
    setForm(EMPTY_FORM);
    setFormError(null);
  };

  const applyOutcome = (outcome: ProviderKeyWriteOutcome, successMessage: string) => {
    if (outcome.ok && outcome.result) {
      // Reflect the server's document, not what the form hoped for.
      const created = outcome.result;
      setEntries((current) => {
        const next = current.filter((entry) => entry.id !== created.id);
        next.push({ id: created.id, revision: created.revision, value: created.value });
        return next.sort((a, b) => a.value.display_name.localeCompare(b.value.display_name));
      });
      setNotice({ tone: "ok", message: successMessage });
      return;
    }
    setNotice({
      tone: "error",
      message: describeWriteFailure(outcome.failure ?? "failed", outcome.reason, (key, fallback) =>
        text(key, fallback)
      ),
    });
  };

  const submit = async () => {
    const displayName = form.displayName.trim();
    if (displayName.length === 0) {
      setFormError(text("providerKeysNameRequired", "A display name is required."));
      return;
    }
    // `api_key` is REQUIRED on create and OPTIONAL on patch; that asymmetry is
    // the handler's, so it is enforced here rather than guessed at the call site.
    const apiKey = form.apiKey.trim();
    if (editor?.mode === "create" && apiKey.length === 0) {
      setFormError(text("providerKeysApiKeyRequired", "An API key is required to create a key."));
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setNotice(null);
    try {
      if (editor?.mode === "edit") {
        const outcome = await updateProviderKey(editor.entry.id, {
          displayName,
          apiKey: apiKey.length > 0 ? apiKey : undefined,
          provider: form.provider,
          apiBase: form.apiBase,
        });
        applyOutcome(
          outcome,
          text("providerKeysUpdated", "Provider key updated. The gateway returned this document.")
        );
        if (outcome.ok) closeEditor();
        return;
      }
      const outcome = await createProviderKey({
        displayName,
        apiKey,
        provider: form.provider,
        apiBase: form.apiBase,
      });
      applyOutcome(
        outcome,
        text("providerKeysCreated", "Provider key created. The gateway returned this document.")
      );
      if (outcome.ok) closeEditor();
    } finally {
      setSubmitting(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const outcome = await deleteProviderKey(deleteTarget.id);
      if (outcome.ok) {
        // The 200 body is `{id, status, version}` — no document — so the row is
        // removed by the id the server echoed, not by a guess.
        setEntries((current) => current.filter((entry) => entry.id !== deleteTarget.id));
        setNotice({
          tone: "ok",
          message: text("providerKeysDeleted", "Provider key deleted."),
        });
        setDeleteTarget(null);
        return;
      }
      setNotice({
        tone: "error",
        message: describeWriteFailure(
          outcome.failure ?? "failed",
          outcome.reason,
          (key, fallback) => text(key, fallback)
        ),
      });
    } finally {
      setDeleting(false);
    }
  };

  const hasAnythingToChange = useMemo(() => {
    if (!editor || editor.mode !== "edit") return true;
    const current = editor.entry.value;
    return (
      form.displayName.trim() !== current.display_name ||
      form.apiKey.trim().length > 0 ||
      form.provider.trim() !== (current.provider ?? "") ||
      form.apiBase.trim() !== (current.api_base ?? "")
    );
  }, [editor, form]);

  return (
    <div className="flex flex-col gap-4" data-testid="provider-keys-section">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold flex items-center gap-2 flex-1 min-w-0">
          {text("providerKeysTitle", "Upstream provider keys")}
          {state === "ready" && (
            <span className="text-xs font-normal text-text-muted" data-testid="provider-keys-count">
              {entries.length}
            </span>
          )}
        </h2>
        {state === "ready" && (
          <Button size="sm" icon="add" onClick={openCreate} data-testid="provider-keys-create">
            {text("providerKeysCreate", "Add provider key")}
          </Button>
        )}
      </div>
      <p className="text-sm text-text-muted -mt-2">
        {text(
          "providerKeysSubtitle",
          "Credentials the gateway sends upstream, managed through its admin API — not the local database."
        )}
      </p>

      {state === "loading" && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3" aria-busy="true">
          {[0, 1].map((slot) => (
            <Card key={slot} padding="sm">
              <div className="h-4 w-1/2 rounded bg-black/10 dark:bg-white/10 animate-pulse" />
              <div className="mt-2 h-3 w-full rounded bg-black/5 dark:bg-white/5 animate-pulse" />
            </Card>
          ))}
        </div>
      )}

      {state === "missing" && (
        <div
          className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm"
          data-testid="provider-keys-missing"
        >
          <span className="material-symbols-outlined text-[18px]">cloud_off</span>
          <span>
            {text(
              "providerKeysMissing",
              "This gateway build has no /admin/v1/provider_keys surface."
            )}
          </span>
        </div>
      )}

      {state === "denied" && (
        <div
          className="flex flex-wrap items-center gap-3 py-4 px-4 border border-dashed border-amber-500/40 rounded-xl text-sm"
          data-testid="provider-keys-denied"
        >
          <span className="material-symbols-outlined text-[18px] text-amber-500">lock</span>
          <span className="text-text-main flex-1 min-w-[240px]">
            {text("aisixAdminKeyRequired", "")}
          </span>
          <Button size="sm" variant="secondary" icon="refresh" onClick={reload}>
            {tCommon("retry")}
          </Button>
        </div>
      )}

      {state === "error" && (
        <div
          className="flex flex-wrap items-center gap-3 py-4 px-4 border border-dashed border-red-500/40 rounded-xl text-sm"
          data-testid="provider-keys-error"
        >
          <span className="material-symbols-outlined text-[18px] text-red-500">error</span>
          <span className="text-text-main flex-1 min-w-[200px]">
            {text(
              "providerKeysLoadError",
              "Failed to load provider keys. The list is unknown — not empty."
            )}
          </span>
          <Button size="sm" variant="secondary" icon="refresh" onClick={reload}>
            {tCommon("retry")}
          </Button>
        </div>
      )}

      {notice && (
        <div
          role="status"
          data-testid="provider-keys-notice"
          data-tone={notice.tone}
          className={`flex items-start gap-2 py-3 px-4 border rounded-xl text-sm ${
            notice.tone === "ok"
              ? "border-emerald-500/40 text-text-main"
              : "border-red-500/40 text-text-main"
          }`}
        >
          <span
            className={`material-symbols-outlined text-[18px] ${
              notice.tone === "ok" ? "text-emerald-500" : "text-red-500"
            }`}
          >
            {notice.tone === "ok" ? "check_circle" : "error"}
          </span>
          <span className="break-words">{notice.message}</span>
        </div>
      )}

      {state === "ready" && (
        <>
          {entries.length === 0 ? (
            <div
              className="flex items-center gap-2 py-4 px-4 border border-dashed border-border rounded-xl text-text-muted text-sm"
              data-testid="provider-keys-empty"
            >
              <span className="material-symbols-outlined text-[18px]">vpn_key</span>
              <span>{text("providerKeysEmpty", "No upstream provider keys yet.")}</span>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3" data-testid="provider-keys-list">
              {entries.map((entry) => (
                <Card key={entry.id} padding="sm" data-testid={`provider-key-${entry.id}`}>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p
                          className="font-semibold text-text-main truncate"
                          title={entry.value.display_name}
                        >
                          {entry.value.display_name}
                        </p>
                        <p
                          className="text-[11px] text-text-muted font-mono truncate"
                          title={entry.id}
                        >
                          {entry.id}
                        </p>
                      </div>
                      <Badge size="sm" variant="neutral">
                        {text("providerKeysRevision", "rev {revision}", {
                          revision: entry.revision,
                        })}
                      </Badge>
                    </div>

                    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                      <dt className="text-text-muted">
                        {text("providerKeysProviderLabel", "Provider id")}
                      </dt>
                      <dd className="font-mono truncate" title={entry.value.provider || ""}>
                        {entry.value.provider && entry.value.provider.length > 0
                          ? entry.value.provider
                          : text("providerKeysUnset", "not reported")}
                      </dd>
                      <dt className="text-text-muted">{text("baseUrlLabel", "Base URL")}</dt>
                      <dd className="font-mono truncate" title={entry.value.api_base || ""}>
                        {entry.value.api_base && entry.value.api_base.length > 0
                          ? entry.value.api_base
                          : text("providerKeysUnset", "not reported")}
                      </dd>
                      <dt className="text-text-muted">
                        {text("providerKeysApiKeyLabel", "API key")}
                      </dt>
                      <dd>{text("providerKeysApiKeyStored", "stored — value not shown")}</dd>
                      {Array.isArray(entry.value.strip_headers) &&
                        entry.value.strip_headers.length > 0 && (
                          <>
                            <dt className="text-text-muted">
                              {text("providerKeysStripHeaders", "Headers stripped")}
                            </dt>
                            <dd
                              className="font-mono truncate"
                              title={entry.value.strip_headers.join(", ")}
                            >
                              {entry.value.strip_headers.join(", ")}
                            </dd>
                          </>
                        )}
                    </dl>

                    <div className="flex flex-wrap gap-2 mt-1">
                      <Button
                        size="sm"
                        variant="secondary"
                        icon="edit"
                        onClick={() => openEdit(entry)}
                        data-testid={`provider-keys-edit-${entry.id}`}
                      >
                        {tCommon("edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        icon="delete"
                        onClick={() => {
                          setNotice(null);
                          setDeleteTarget(entry);
                        }}
                        data-testid={`provider-keys-delete-${entry.id}`}
                      >
                        {tCommon("delete")}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {editor && (
        <Card padding="sm" data-testid="provider-keys-editor">
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-semibold text-text-main">
              {editor.mode === "create"
                ? text("providerKeysCreate", "Add provider key")
                : text("providerKeysEditing", "Editing {name}", {
                    name: editor.entry.value.display_name,
                  })}
            </h3>
            <Input
              label={text("displayName", "Display Name")}
              value={form.displayName}
              onChange={(event) => setForm({ ...form, displayName: event.target.value })}
              data-testid="provider-keys-form-name"
            />
            <Input
              label={text("providerKeysApiKeyLabel", "API key")}
              type="password"
              value={form.apiKey}
              onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              placeholder={editor.mode === "edit" ? "•••" : "sk-…"}
              hint={
                editor.mode === "edit"
                  ? text(
                      "providerKeysApiKeyEditHint",
                      "Leave empty to keep the stored key. The gateway returns the stored value but this form never re-sends it."
                    )
                  : undefined
              }
              data-testid="provider-keys-form-key"
            />
            <Input
              label={text("providerKeysProviderLabel", "Provider id")}
              value={form.provider}
              onChange={(event) => setForm({ ...form, provider: event.target.value })}
              data-testid="provider-keys-form-provider"
            />
            <Input
              label={text("baseUrlLabel", "Base URL")}
              value={form.apiBase}
              onChange={(event) => setForm({ ...form, apiBase: event.target.value })}
              placeholder="https://api.example.com/v1"
              data-testid="provider-keys-form-base"
            />
            {formError && (
              <p className="text-xs text-red-500" data-testid="provider-keys-form-error">
                {formError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                onClick={submit}
                loading={submitting}
                disabled={!hasAnythingToChange}
                data-testid="provider-keys-form-submit"
              >
                {submitting ? tCommon("loading") : tCommon("save")}
              </Button>
              <Button size="sm" variant="secondary" onClick={closeEditor} disabled={submitting}>
                {tCommon("cancel")}
              </Button>
            </div>
          </div>
        </Card>
      )}

      <ConfirmModal
        isOpen={Boolean(deleteTarget)}
        onClose={() => {
          setDeleteTarget(null);
        }}
        onConfirm={confirmDelete}
        loading={deleting}
        title={text("providerKeysDeleteTitle", "Delete provider key")}
        message={text(
          "providerKeysDeleteConfirm",
          'Delete provider key "{name}"? A model or passthrough route that still references it makes the gateway refuse with 409.',
          { name: deleteTarget?.value.display_name ?? "" }
        )}
        confirmText={tCommon("delete")}
        variant="danger"
      />
    </div>
  );
}
