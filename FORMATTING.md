# Code Formatting Guide

To avoid wasting AI tokens on code formatting, it's highly recommended to use local formatters like Prettier instead.

## How to Format Code locally

I have configured **Prettier** for this project. Instead of asking me (the AI) to organize or format your code, you can use Prettier to do it instantly and automatically.

### Running the Formatter manually

You can run the formatter across your entire project using npm:

```bash
npm run format
```

This will automatically fix indentation, line breaks, spacing, quotes, and other stylistic issues in all supported files (`.js`, `.json`, `.css`, etc.).

### Setting up Auto-Format on Save

The most efficient way to maintain clean code without thinking about it is to enable "Format on Save" in your code editor.

#### In VS Code

1. Open Settings (`Ctrl+,` or `Cmd+,`)
2. Search for `Format On Save`
3. Check the box to enable it
4. Search for `Default Formatter`
5. Select `Prettier - Code formatter` (you may need to install the Prettier extension first)

By relying on `npm run format` or your editor's auto-format, you keep your code clean and save AI tokens for actual problem-solving and feature development!
