{
  description = "Kronikarz — digitalizacja schematow elektronicznych";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          name = "kronikarz";

          packages = with pkgs; [
            nodejs_22

            typescript
            prettier
            eslint

            yq-go

            git
            git-lfs

            just
            watchexec
            httpie
            jq

            mdbook
          ];

          shellHook = ''
            echo ""
            echo "  KRONIKARZ — srodowisko deweloperskie"
            echo "  ====================================="
            echo "  node:    $(node --version)"
            echo "  npm:     $(npm --version)"
            echo "  just:    $(just --version)"
            echo ""
            echo "  Komendy:"
            echo "    just dev       uruchom viewer + serwer"
            echo "    just lint      sprawdz kod"
            echo "    just export    eksportuj przykladowy pakiet"
            echo ""

            if [ ! -d "node_modules" ]; then
              echo "  Instaluje zaleznosci npm..."
              npm install --silent
            fi
          '';

          KRONIKARZ_DATA = "./data";
          NODE_ENV = "development";
        };
      }
    );
}
