# pi-question

Interactive opencode-style `question` tool for pi.

## Tool

`question` asks one or more structured questions and waits for the user to answer.

```ts
{
  questions: [{
    question: "Which implementation?",
    header: "Approach",
    options: [
      { label: "Small extension", description: "No core changes" },
      { label: "Core change", description: "Requires maintaining behavior in pi itself" }
    ],
    multiple: false
  }]
}
```

Answers are returned as `string[][]`, one answer array per question. `multiple: true` allows multiple selected labels. A typed custom answer option is always available.

Calls are bounded to 8 questions and 12 options per question. Question text and option descriptions accept up to 500 characters; labels accept up to 120 characters. Long option lists use a terminal-height-aware scrolling viewport.

## UI keys

- `↑↓` / `j k` select or scroll the review
- `1-9` pick by number
- `enter` select/toggle/submit
- `tab` / `←→` navigate questions
- `esc` dismiss, or cancel custom-answer editing
