```markdown
# santa-teresita-app Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns and conventions used in the `santa-teresita-app` TypeScript codebase. You'll learn how to write code that matches the project's style, structure commits, organize files, and structure tests. This guide is essential for contributing code that is consistent and maintainable.

## Coding Conventions

### File Naming
- Use **camelCase** for file names.
  - Example: `userProfile.ts`, `orderService.ts`

### Import Style
- Use **alias imports** for modules.
  - Example:
    ```typescript
    import userService from '@/services/userService';
    ```

### Export Style
- Use **default exports** for modules.
  - Example:
    ```typescript
    const userService = { /* ... */ };
    export default userService;
    ```

### Commit Messages
- Follow **Conventional Commits**.
- Use the `feat` prefix for new features.
- Commit message length averages 77 characters.
  - Example:
    ```
    feat: add user authentication to login page
    ```

## Workflows

### Feature Development
**Trigger:** When adding a new feature to the app  
**Command:** `/feature-development`

1. Create a new TypeScript file using camelCase naming.
2. Write your code, using alias imports and default exports.
3. Add or update relevant tests in files matching `*.test.*`.
4. Commit your changes using the `feat` prefix and a clear description.
    - Example: `feat: implement booking confirmation modal`
5. Open a pull request for review.

## Testing Patterns

- Test files follow the `*.test.*` pattern (e.g., `userService.test.ts`).
- The specific testing framework is not detected, but tests should be placed alongside or near the code they cover.
- Example test file:
  ```typescript
  // userService.test.ts
  import userService from '@/services/userService';

  describe('userService', () => {
    it('should authenticate user', () => {
      // test implementation
    });
  });
  ```

## Commands
| Command                | Purpose                                 |
|------------------------|-----------------------------------------|
| /feature-development   | Guide for adding a new feature          |
```
