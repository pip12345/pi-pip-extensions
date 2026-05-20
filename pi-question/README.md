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
    multiple: false,
    custom: true
  }]
}
```

Answers are returned as `string[][]`, one answer array per question. `multiple: true` allows multiple selected labels. `custom !== false` enables a typed answer option.

## UI keys

- `↑↓` / `j k` select
- `1-9` pick by number
- `enter` select/toggle/submit
- `tab` / `←→` navigate questions
- `esc` dismiss, or cancel custom-answer editing
