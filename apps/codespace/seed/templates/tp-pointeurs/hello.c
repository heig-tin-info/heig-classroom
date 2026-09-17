#include <stdio.h>

/* TP 3 — pointeurs et tableaux.
 * Compiler avec `make`, déboguer avec F5 (configuration « Déboguer hello »). */

static int somme(const int *tableau, size_t taille) {
  int total = 0;
  for (size_t i = 0; i < taille; i++) {
    total += tableau[i];
  }
  return total;
}

int main(void) {
  int valeurs[] = {1, 2, 3, 4, 5};
  size_t taille = sizeof valeurs / sizeof valeurs[0];
  printf("somme = %d\n", somme(valeurs, taille));
  return 0;
}
