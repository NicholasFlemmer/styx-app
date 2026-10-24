"""Offline reproduction for Styx issue 18; this is not an Aider adapter."""

import contextlib
import importlib.metadata
import io
import os
from pathlib import Path
import socket
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


class ApprovalCases(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        previous = Path.cwd()
        os.chdir(self.root)
        self.addCleanup(os.chdir, previous)
        self.home = self.root / "home"
        self.home.mkdir()
        environment = patch.dict(
            os.environ,
            {"HOME": str(self.home), "USERPROFILE": str(self.home)},
        )
        environment.start()
        self.addCleanup(environment.stop)

    def parser(self, configs=()):
        from aider.args import get_parser

        return get_parser([str(path) for path in configs], str(self.root))

    def config(self, name, text):
        path = self.root / name
        path.write_text(text, encoding="utf-8")
        return path

    def test_clean_parser_does_not_enable_yes_always(self):
        self.assertIsNone(self.parser().parse_args([]).yes_always)

    def test_false_environment_without_yaml_does_not_enable_yes_always(self):
        with patch.dict(os.environ, {"AIDER_YES_ALWAYS": "false"}):
            self.assertIsNone(self.parser().parse_args([]).yes_always)

    def test_false_environment_does_not_override_true_yaml(self):
        project = self.config("project.yml", "yes-always: true\n")
        with patch.dict(os.environ, {"AIDER_YES_ALWAYS": "false"}):
            args = self.parser([project]).parse_args([])
            self.assertIs(args.yes_always, True)

    def test_private_false_config_also_leaves_true_yaml_enabled(self):
        project = self.config("project.yml", "yes-always: true\n")
        private = self.config("private.yml", "yes-always: false\n")
        with patch.dict(os.environ, {"AIDER_YES_ALWAYS": "false"}):
            args = self.parser([project]).parse_args(
                ["--config", str(private)]
            )
            self.assertIs(args.yes_always, True)

    def test_dotenv_reload_overrides_launch_environment(self):
        from aider.main import load_dotenv_files

        project = self.config("project.env", "AIDER_YES_ALWAYS=true\n")
        with patch.dict(os.environ, {"AIDER_YES_ALWAYS": "false"}):
            parser = self.parser()
            argv = ["--env-file", str(project)]
            first, _ = parser.parse_known_args(argv)
            self.assertIsNone(first.yes_always)
            loaded = load_dotenv_files(
                str(self.root), first.env_file, first.encoding
            )
            self.assertIn(str(project), loaded)
            self.assertEqual(os.environ["AIDER_YES_ALWAYS"], "true")
            self.assertIs(parser.parse_args(argv).yes_always, True)

    def test_negative_yes_always_flag_is_not_supported(self):
        errors = io.StringIO()
        with contextlib.redirect_stderr(errors):
            with self.assertRaises(SystemExit) as rejected:
                self.parser().parse_args(["--no-yes-always"])
        self.assertEqual(rejected.exception.code, 2)
        self.assertIn(
            "unrecognized arguments: --no-yes-always", errors.getvalue()
        )

    def coder(self, in_chat, dry_run=False):
        from aider.coders.editblock_coder import EditBlockCoder
        from aider.io import InputOutput

        target = self.root / "example.txt"
        target.write_text("before\n", encoding="utf-8")
        terminal = InputOutput(
            yes=None,
            pretty=False,
            fancy_input=False,
            output=io.StringIO(),
            dry_run=dry_run,
            line_endings="lf",
        )
        # Stub metadata; parsing, permission checks and writes are Aider's.
        model = SimpleNamespace(reasoning_tag=None, streaming=False, info={})
        coder = EditBlockCoder(
            main_model=model,
            io=terminal,
            fnames=[str(target)] if in_chat else [],
            use_git=False,
            auto_commits=False,
            dirty_commits=False,
            map_tokens=0,
            auto_lint=False,
            auto_test=False,
            suggest_shell_commands=False,
            detect_urls=False,
            dry_run=dry_run,
            summarizer=object(),
            analytics=SimpleNamespace(event=lambda *args, **kwargs: None),
        )
        return coder, target

    def edit(self, coder, before="before", after="after"):
        # Supply a deterministic model-shaped reply; never call a model.
        coder.partial_response_content = (
            "example.txt\n```text\n<<<<<<< SEARCH\n"
            f"{before}\n=======\n{after}\n>>>>>>> REPLACE\n```\n"
        )
        return coder.apply_updates()

    def test_already_in_chat_file_is_written_without_confirmation(self):
        coder, target = self.coder(in_chat=True)
        self.assertIsNone(coder.io.yes)
        with (
            patch("builtins.input", return_value="n") as answers,
            patch.object(
                coder.io, "confirm_ask", wraps=coder.io.confirm_ask
            ) as asks,
        ):
            self.assertEqual(self.edit(coder), {"example.txt"})
        self.assertEqual(target.read_text(encoding="utf-8"), "after\n")
        asks.assert_not_called()
        answers.assert_not_called()

    def test_outside_chat_file_can_be_rejected(self):
        coder, target = self.coder(in_chat=False)
        with (
            patch("builtins.input", return_value="n") as answers,
            patch.object(
                coder.io, "confirm_ask", wraps=coder.io.confirm_ask
            ) as asks,
        ):
            self.assertEqual(self.edit(coder), set())
        self.assertEqual(target.read_text(encoding="utf-8"), "before\n")
        asks.assert_called_once()
        self.assertIn("not been added to the chat", asks.call_args.args[0])
        answers.assert_called_once()

    def test_admission_approval_does_not_prompt_for_next_edit(self):
        coder, target = self.coder(in_chat=False)
        with (
            patch("builtins.input", return_value="y") as answers,
            patch.object(
                coder.io, "confirm_ask", wraps=coder.io.confirm_ask
            ) as asks,
        ):
            self.assertEqual(self.edit(coder), {"example.txt"})
        self.assertEqual(target.read_text(encoding="utf-8"), "after\n")
        asks.assert_called_once()
        answers.assert_called_once()
        with (
            patch("builtins.input", return_value="n") as answers,
            patch.object(
                coder.io, "confirm_ask", wraps=coder.io.confirm_ask
            ) as asks,
        ):
            self.assertEqual(
                self.edit(coder, "after", "second"), {"example.txt"}
            )
        self.assertEqual(target.read_text(encoding="utf-8"), "second\n")
        asks.assert_not_called()
        answers.assert_not_called()

    def test_new_file_can_be_rejected(self):
        coder, target = self.coder(in_chat=False)
        target.unlink()
        coder.partial_response_content = (
            "example.txt\n```text\n<<<<<<< SEARCH\n"
            "=======\nnew\n>>>>>>> REPLACE\n```\n"
        )
        with (
            patch("builtins.input", return_value="n") as answers,
            patch.object(
                coder.io, "confirm_ask", wraps=coder.io.confirm_ask
            ) as asks,
        ):
            self.assertEqual(coder.apply_updates(), set())
        self.assertFalse(target.exists())
        asks.assert_called_once_with("Create new file?", subject="example.txt")
        answers.assert_called_once()

    def test_dry_run_prevents_the_in_chat_write(self):
        coder, target = self.coder(in_chat=True, dry_run=True)
        with patch("builtins.input", return_value="n") as answers:
            self.assertEqual(self.edit(coder), {"example.txt"})
        self.assertEqual(target.read_text(encoding="utf-8"), "before\n")
        answers.assert_not_called()


def main():
    packages = ("aider-chat", "ConfigArgParse", "python-dotenv")
    versions = {name: importlib.metadata.version(name) for name in packages}
    if versions["aider-chat"] not in ("0.86.0", "0.86.2"):
        raise SystemExit(
            "Use aider-chat==0.86.0 or aider-chat==0.86.2 "
            "for this reproduction"
        )
    if versions["ConfigArgParse"] != "1.7.1":
        raise SystemExit("Use ConfigArgParse==1.7.1 for this reproduction")
    print("Versions:", versions, flush=True)
    previous = Path.cwd()
    with tempfile.TemporaryDirectory(prefix="styx-aider-approval-") as sandbox:
        environment = {
            key: os.environ[key]
            for key in ("PATH", "SYSTEMROOT", "WINDIR")
            if key in os.environ
        }
        environment.update(
            HOME=sandbox,
            USERPROFILE=sandbox,
            XDG_CONFIG_HOME=sandbox,
            XDG_CACHE_HOME=sandbox,
            TEMP=sandbox,
            TMP=sandbox,
            AIDER_ANALYTICS="false",
            LITELLM_LOCAL_MODEL_COST_MAP="True",
        )
        try:
            os.chdir(sandbox)
            # No inherited credentials or user config. Reject connections.
            with (
                patch.dict(os.environ, environment, clear=True),
                patch.object(
                    socket.socket, "connect",
                    side_effect=RuntimeError("Offline reproduction"),
                ),
                patch.object(
                    socket.socket, "connect_ex",
                    side_effect=RuntimeError("Offline reproduction"),
                ),
            ):
                suite = unittest.defaultTestLoader.loadTestsFromTestCase(
                    ApprovalCases
                )
                result = unittest.TextTestRunner(verbosity=2).run(suite)
        finally:
            os.chdir(previous)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
