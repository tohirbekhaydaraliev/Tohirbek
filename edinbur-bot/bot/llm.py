"""Claude (Anthropic API) bilan ishlovchi yupqa qatlam. Sinovlarda soxta LLM bilan almashtiriladi."""

from __future__ import annotations

from typing import Protocol

import anthropic
from anthropic.types import Message


class LLM(Protocol):
    async def create(self, *, system: str, tools: list[dict], messages: list[dict]) -> Message: ...


class ClaudeLLM:
    def __init__(self, *, api_key: str, model: str, effort: str, max_tokens: int = 4096):
        # SDK 429/5xx va tarmoq xatolarini o'zi 2 marta qayta urinadi
        self.client = anthropic.AsyncAnthropic(api_key=api_key, timeout=60.0, max_retries=2)
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens

    async def create(self, *, system: str, tools: list[dict], messages: list[dict]) -> Message:
        return await self.client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            system=system,
            tools=tools,
            messages=messages,
            thinking={"type": "adaptive"},
            output_config={"effort": self.effort},
            # Takrorlanuvchi prefiks (system + oldingi xabarlar) keshlanadi - arzonroq va tezroq
            cache_control={"type": "ephemeral"},
        )
