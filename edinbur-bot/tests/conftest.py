import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
from anthropic.types import Message, TextBlock, ThinkingBlock, ToolUseBlock, Usage

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from bot.agent import Agent  # noqa: E402
from bot.channels.base import IncomingMessage, LogNotifier  # noqa: E402
from bot.knowledge import Knowledge  # noqa: E402
from bot.storage import Storage  # noqa: E402


def text_reply(text: str, *, thinking: bool = True) -> Message:
    content = [ThinkingBlock(type="thinking", thinking="", signature="sig")] if thinking else []
    content.append(TextBlock(type="text", text=text))
    return _message(content, "end_turn")


def tool_call(name: str, args: dict, tool_id: str = "toolu_1") -> Message:
    return _message(
        [
            ThinkingBlock(type="thinking", thinking="", signature="sig"),
            ToolUseBlock(type="tool_use", id=tool_id, name=name, input=args),
        ],
        "tool_use",
    )


def _message(content, stop_reason: str) -> Message:
    return Message(
        id="msg_test",
        type="message",
        role="assistant",
        model="claude-haiku-5-5",
        content=content,
        stop_reason=stop_reason,
        stop_sequence=None,
        usage=Usage(input_tokens=1, output_tokens=1),
    )


class FakeLLM:
    """Oldindan yozilgan javoblarni navbat bilan qaytaradi va so'rovlarni eslab qoladi."""

    def __init__(self):
        self.responses: list = []
        self.requests: list[dict] = []

    def queue(self, *responses):
        self.responses.extend(responses)

    async def create(self, *, system, tools, messages):
        self.requests.append({"system": system, "tools": tools, "messages": messages})
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return response


class Clock:
    def __init__(self):
        self.now = datetime(2026, 10, 10, 9, 30, tzinfo=timezone.utc)

    def __call__(self):
        return self.now


@pytest.fixture
def knowledge_file(tmp_path):
    path = tmp_path / "knowledge.md"
    path.write_text("# Test markaz\n<!-- yashirin izoh -->\n- Kurslar: Ingliz tili, Rus tili\n", encoding="utf-8")
    return path


@pytest.fixture
def env(tmp_path, knowledge_file):
    class Env:
        pass

    e = Env()
    e.db_path = tmp_path / "bot.db"
    e.storage = Storage(e.db_path)
    e.llm = FakeLLM()
    e.notifier = LogNotifier()
    e.clock = Clock()
    e.knowledge_file = knowledge_file
    e.agent = Agent(
        storage=e.storage,
        llm=e.llm,
        notifier=e.notifier,
        knowledge=Knowledge(knowledge_file),
        clock=e.clock,
    )
    return e


def incoming(text: str, user_id: str = "42") -> IncomingMessage:
    return IncomingMessage(channel="telegram", user_id=user_id, text=text, client_ref="@test_user")
