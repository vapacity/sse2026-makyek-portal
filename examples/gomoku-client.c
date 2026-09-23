#include <stdio.h>
#include <string.h>

#define BOARD_SIZE 12

static int board[BOARD_SIZE][BOARD_SIZE];

static void initialize_board(void) {
  int p = BOARD_SIZE / 2 - 1;
  memset(board, 0, sizeof(board));
  board[p][p] = 1;
  board[p][p + 1] = 1;
  board[p + 1][p] = 1;
  board[p + 1][p + 1] = 1;
}

int main(void) {
  char command[16];
  char field[16];
  int x;
  int y;

  initialize_board();
  while (scanf("%15s", command) == 1) {
    if (strcmp(command, "START") == 0) {
      if (scanf("%15s", field) != 1) return 1;
      puts("OK");
      fflush(stdout);
    } else if (strcmp(command, "PLACE") == 0) {
      if (scanf("%d%d", &x, &y) != 2) return 1;
      if (x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE) {
        board[x][y] = 1;
      }
    } else if (strcmp(command, "TURN") == 0) {
      int moved = 0;
      for (x = 0; x < BOARD_SIZE && !moved; ++x) {
        for (y = 0; y < BOARD_SIZE; ++y) {
          if (board[x][y] == 0) {
            board[x][y] = 1;
            printf("%d %d\n", x, y);
            fflush(stdout);
            moved = 1;
            break;
          }
        }
      }
    }
  }
  return 0;
}
