import { useEffect, useState } from "react";
import type { NewChatInput, ProjectNameCheck } from "../../shared/ipc.js";
import { IconCheck, IconFolder, IconPlus } from "../lib/icons.js";
import { Button, Modal, TextField, cx } from "./ui.js";

type Mode = "project" | "folder";

interface NewChatDialogProps {
  open: boolean;
  projectsRoot: string;
  onClose: () => void;
  onCreate: (input: NewChatInput) => void;
}

/**
 * A chat's workspace is chosen here and fixed for its lifetime, so this is the
 * only place either option is offered.
 */
export function NewChatDialog({ open, projectsRoot, onClose, onCreate }: NewChatDialogProps) {
  const [mode, setMode] = useState<Mode>("project");
  const [name, setName] = useState("");
  const [check, setCheck] = useState<ProjectNameCheck | null>(null);
  const [folder, setFolder] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMode("project");
    setName("");
    setCheck(null);
    setFolder(null);
    setBusy(false);
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "project") return;
    let cancelled = false;
    void window.pi.checkProjectName(name).then((result) => {
      if (!cancelled) setCheck(result);
    });
    return () => {
      cancelled = true;
    };
  }, [name, mode, open]);

  const canCreate =
    !busy && (mode === "project" ? Boolean(name.trim() && check?.valid) : Boolean(folder));

  const create = () => {
    if (!canCreate) return;
    setBusy(true);
    onCreate(
      mode === "project"
        ? { kind: "project", name: name.trim() }
        : { kind: "folder", path: folder as string },
    );
  };

  const pickFolder = async () => {
    const picked = await window.pi.chooseDirectory();
    if (picked) setFolder(picked);
  };

  return (
    <Modal open={open} onClose={onClose} title="New chat" width="max-w-lg">
      <div className="px-5 py-4">
        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setMode("project")}
            className={cx(
              "flex items-start gap-2.5 rounded-xl border p-3 text-left transition",
              mode === "project"
                ? "border-iris-500/60 bg-iris-600/10"
                : "border-ink-700 hover:border-ink-600",
            )}
          >
            <IconPlus className="mt-0.5 h-4 w-4 shrink-0 text-iris-400" />
            <span>
              <span className="block text-[13px] font-medium text-mist-100">New project</span>
              <span className="mt-0.5 block text-[11.5px] text-mist-500">
                Create an empty folder to work in
              </span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMode("folder")}
            className={cx(
              "flex items-start gap-2.5 rounded-xl border p-3 text-left transition",
              mode === "folder"
                ? "border-iris-500/60 bg-iris-600/10"
                : "border-ink-700 hover:border-ink-600",
            )}
          >
            <IconFolder className="mt-0.5 h-4 w-4 shrink-0 text-mist-400" />
            <span>
              <span className="block text-[13px] font-medium text-mist-100">Existing folder</span>
              <span className="mt-0.5 block text-[11.5px] text-mist-500">
                Work in a folder already on disk
              </span>
            </span>
          </button>
        </div>

        {mode === "project" ? (
          <div className="space-y-2">
            <span className="block text-[12px] font-medium text-mist-300">Project name</span>
            <TextField
              autoFocus
              value={name}
              onChange={setName}
              onEnter={create}
              placeholder="my-api-server"
            />
            {name.trim() && check?.error ? (
              <p className="text-[11.5px] text-rose-soft">{check.error}</p>
            ) : (
              <p className="flex items-center gap-1.5 text-[11.5px] text-mist-500">
                {check?.valid && <IconCheck className="h-3 w-3 shrink-0 text-jade-400" />}
                <span className="truncate font-mono">
                  {name.trim() ? check?.path : `${projectsRoot}/…`}
                </span>
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <span className="block text-[12px] font-medium text-mist-300">Folder</span>
            <div className="flex items-center gap-2">
              <code
                className={cx(
                  "min-w-0 flex-1 truncate rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 font-mono text-[11.5px]",
                  folder ? "text-mist-200" : "text-mist-500",
                )}
              >
                {folder ?? "No folder chosen"}
              </code>
              <Button variant="outline" onClick={() => void pickFolder()}>
                Choose…
              </Button>
            </div>
          </div>
        )}

        <p className="mt-4 text-[11.5px] leading-relaxed text-mist-500">
          The agent reads, writes, and runs commands in this folder. It is fixed for the life of
          the chat — start another chat to work somewhere else.
        </p>
      </div>

      <div className="flex justify-end gap-2 border-t border-ink-800 px-5 py-3">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={!canCreate} onClick={create}>
          {busy ? "Creating…" : "Create chat"}
        </Button>
      </div>
    </Modal>
  );
}
