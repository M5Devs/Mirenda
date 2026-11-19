// Command mirenda-proxyd is the placeholder entrypoint for Mirenda's future
// tunneling / VPN service. It currently serves only a health endpoint so the
// module builds, runs, and gives the deployment pipeline something to probe.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// version is reported by /healthz so a deploy can be verified without logs.
const version = "0.1.0-stub"

type healthResponse struct {
	Status  string `json:"status"`
	Service string `json:"service"`
	Version string `json:"version"`
}

func newMux() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(healthResponse{
			Status:  "ok",
			Service: "mirenda-proxyd",
			Version: version,
		})
	})
	// Tunnel endpoints are documented in README.md and land in a later phase.
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "not implemented", http.StatusNotImplemented)
	})
	return mux
}

func main() {
	addr := os.Getenv("MIRENDA_PROXYD_ADDR")
	if addr == "" {
		addr = "127.0.0.1:8788"
	}

	server := &http.Server{
		Addr:              addr,
		Handler:           newMux(),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	go func() {
		log.Printf("mirenda-proxyd %s listening on %s", version, addr)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("listen: %v", err)
		}
	}()

	<-ctx.Done()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		log.Printf("shutdown: %v", err)
	}
}
